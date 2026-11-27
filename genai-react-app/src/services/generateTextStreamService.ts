import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { GenerateTextStreamRequest } from "../models/generateText.models";
import { WebSource } from "../models/conversation.models";
import { ActivityEvent, isActivityEvent } from "@genflowly/component-library";
import { AttachmentRef } from "../models/attachment.models";
import { fetchWithRetry } from "../utils/apiUtils";
import { timeReply } from "../observability/sentry";

/** Vendor failure relayed mid-stream by the proxy ({"t":"err"} chunk, or a {"t":"done","status":"error"} terminal frame). */
export class StreamGenerationError extends Error {}

/**
 * The stream ended without ever receiving a {"t":"done"} terminal frame — the
 * connection was cut before the server could say whether generation finished
 * or failed. Treated more leniently than StreamGenerationError: the caller
 * should try to recover the persisted message and only show an error if that
 * also comes up empty, since this is the normal shape of e.g. a backgrounded
 * mobile tab where the server-side generation keeps running to completion.
 */
export class StreamTruncatedError extends Error {}

/** Stop reason of a reply the user stopped; the response card shows a "you stopped" note. */
export const STOP_REASON_CANCELLED = "cancelled";

export interface StreamMetadata {
    conversationId: string | null;
    messageId: string | null;
    responseMessageId: string | null;
    aiVendor: string | null;
    /**
     * Instruction the server actually applied to this turn — the explicit
     * selection, or the customer's default when the request sent none.
     */
    instructionId?: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    tokensReadFromCache: number | null;
    conversationTitle?: string | null;
}

/** Human-in-the-loop request surfaced by a durable run ({"t":"ai"} frame). */
export interface AwaitingInput {
    type?: string;
    node?: string;
    prompt?: string;
    [k: string]: unknown;
}

/** Handlers for the NDJSON chat wire protocol, shared by the live and reattach streams. */
export interface StreamCallbacks {
    onDelta: (chunk: string) => void;
    /**
     * The generation round that just streamed ended in tool calls executed
     * in-graph — its streamed text was a tool-call preamble ("Let me look
     * up…"), not the answer, and a fresh round follows. Discard the text
     * accumulated so far; the preamble stays visible in the activity panel as
     * the round's `reasoning`.
     */
    onContentReset?: () => void;
    /**
     * The vendor's raw finish reason for the turn (end_turn / stop / max_tokens
     * / refusal / content_filter / …). Streamed once, when generation ends —
     * lets the UI always show why it stopped, and a refusal (empty text) isn't
     * a silent blank.
     */
    onStopReason?: (reason: string) => void;
    /** One event of the turn's activity log ({"t":"ac"} frame), for the thinking panel. */
    onActivity?: (event: ActivityEvent) => void;
    onWebSources?: (sources: WebSource[]) => void;
    onGeneratedAttachments?: (attachments: AttachmentRef[]) => void;
    /** A durable run paused for human/client input — render a prompt + reply box. */
    onAwaitingInput?: (payload: AwaitingInput) => void;
}

/**
 * Reads an NDJSON chat stream body ({"t":"c"|"cr"|"sr"|"ac"|"ws"|"ga"|"ai"|"err"|"done"})
 * and dispatches each frame to [cb]. Shared by the live generate-text-stream and
 * the durable-run reattach stream so the frame vocabulary lives in one place.
 */
export async function readNdjsonStream(response: Response, cb: StreamCallbacks): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder("utf-8");
    let lineBuffer = "";
    let doneFrameReceived = false;

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const msg = JSON.parse(trimmed);
            if (msg.t === "c") cb.onDelta(msg.v);
            else if (msg.t === "cr") cb.onContentReset?.();
            else if (msg.t === "sr") {
                if (typeof msg.v === "string" && msg.v) cb.onStopReason?.(msg.v);
            }
            else if (msg.t === "ac") {
                if (isActivityEvent(msg.v)) cb.onActivity?.(msg.v);
            }
            else if (msg.t === "ws") {
                if (Array.isArray(msg.v) && msg.v.length > 0) cb.onWebSources?.(msg.v);
            }
            else if (msg.t === "ga") {
                // Files built-in tools produced (e.g. generated PDFs). The
                // proxy relays the retrieval-server's snake_case artifact
                // shape verbatim — normalize to the AttachmentRef the rest of
                // the app uses.
                if (Array.isArray(msg.v) && msg.v.length > 0) {
                    const refs: AttachmentRef[] = msg.v
                        .filter((a: any) => a && typeof a === "object")
                        .map((a: any) => ({
                            attachmentId: a.artifact_id ?? a.attachmentId ?? "",
                            s3Key: a.key ?? a.s3Key ?? "",
                            mediaType: a.media_type ?? a.mediaType ?? "application/octet-stream",
                            filename: a.filename ?? undefined,
                            sizeBytes: typeof a.size_bytes === "number" ? a.size_bytes : undefined,
                        }))
                        .filter((r: AttachmentRef) => r.attachmentId);
                    if (refs.length > 0) cb.onGeneratedAttachments?.(refs);
                }
            }
            else if (msg.t === "ai") {
                // A durable run paused on an in-graph interrupt() and needs input.
                if (msg.v && typeof msg.v === "object") cb.onAwaitingInput?.(msg.v as AwaitingInput);
            }
            else if (msg.t === "err") {
                // Vendor failure mid-stream (quota exceeded, key rejected, ...)
                // — the proxy relays the concise reason; surface it so the
                // response card shows what actually happened.
                throw new StreamGenerationError(
                    typeof msg.v === "string" && msg.v ? msg.v : "Generation failed"
                );
            }
            else if (msg.t === "done") {
                // Terminal frame: the server's definitive word on how the
                // stream ended.
                doneFrameReceived = true;
                if (msg.status === "cancelled") cb.onStopReason?.(STOP_REASON_CANCELLED);
                if (msg.status === "error") {
                    throw new StreamGenerationError(
                        typeof msg.m === "string" && msg.m ? msg.m : "Generation failed"
                    );
                }
            }
            // other types (heartbeat, etc.) are silently ignored
        } catch (e) {
            if (e instanceof StreamGenerationError) throw e;
            // Not JSON. The proxy emits "[Error: <reason>]" as a raw line when
            // generation fails mid-stream — surface it as an error instead of
            // appending it to the generated text.
            const errorMatch = trimmed.match(/^\[Error: ([\s\S]*)\]$/);
            if (errorMatch) {
                throw new StreamGenerationError(errorMatch[1] || 'Stream failed');
            }
            // Other raw content (legacy format) still flows through as text
            cb.onDelta(line);
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
        }
        // Flush any remaining partial line
        if (lineBuffer) processLine(lineBuffer);
        if (!doneFrameReceived) {
            // The connection closed before the server's terminal frame
            // arrived — we can't tell "finished" from "cut off mid-response".
            // Callers should attempt recovery before treating this as fatal.
            throw new StreamTruncatedError(
                "Connection to the server was lost before the response finished."
            );
        }
    } catch (error) {
        console.error("Error reading stream", error);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export async function generateTextStream(
    token: string,
    request: GenerateTextStreamRequest,
    onDelta: (chunk: string) => void,
    onMetadata?: (metadata: StreamMetadata) => void,
    onActivity?: (event: ActivityEvent) => void,
    signal?: AbortSignal,
    onWebSources?: (sources: WebSource[]) => void,
    onGeneratedAttachments?: (attachments: AttachmentRef[]) => void,
    onAwaitingInput?: (payload: AwaitingInput) => void,
    onContentReset?: () => void,
    onStopReason?: (reason: string) => void
): Promise<void> {
    return timeReply(request.aiConfig, async (timing) => {
        const response = await fetchWithRetry(endpoints.generateTextStream, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(request),
            signal,
        });

        if (response.status === 401 || response.status === 403) {
            const err: any = new Error('Session expired')
            err.error = 'login_required'
            throw err
        }

        if (!response.ok) {
            // The proxy returns {"error": "<reason>"} on failures — surface the
            // real reason instead of a generic status line when it's available
            let reason = '';
            let code: unknown;
            try {
                const body = await response.text();
                try {
                    const parsed = JSON.parse(body);
                    reason = parsed?.error ?? '';
                    code = parsed?.code;
                } catch {
                    reason = body;
                }
            } catch {
                // Body unreadable — fall back to status text only
            }
            reason = (reason || '').trim();
            // Written for the person who sent it, so it needs no status code.
            if (code === 'CONTENT_BLOCKED' && reason) throw new Error(reason);
            throw new Error(
                reason
                    ? `${reason} (HTTP ${response.status})`
                    : `Text generation failed: ${response.status} ${response.statusText}`
            );
        }

        const conversationId = response.headers.get("X-Conversation-Id");
        const messageId = response.headers.get("X-Message-Id");
        const responseMessageId = response.headers.get("X-Response-Message-Id");
        const aiVendor = response.headers.get("X-Ai-Vendor");
        const instructionId = response.headers.get("X-Instruction-Id");

        // Call onMetadata immediately with header-based fields (tokens arrive later via sentinel)
        if (onMetadata) {
            onMetadata({
                conversationId,
                messageId,
                responseMessageId,
                aiVendor,
                instructionId,
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
                tokensReadFromCache: null,
            });
        }

        await readNdjsonStream(response, {
            onDelta: (chunk) => {
                timing.firstToken();
                onDelta(chunk);
            },
            onContentReset,
            onStopReason,
            onActivity,
            onWebSources,
            onGeneratedAttachments,
            onAwaitingInput,
        });
    });
}
