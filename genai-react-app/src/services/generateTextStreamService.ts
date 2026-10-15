import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { GenerateTextStreamRequest } from "../models/generateText.models";
import { ThinkingStep, WebSource } from "../models/conversation.models";
import { AttachmentRef } from "../models/attachment.models";
import { fetchWithRetry } from "../utils/apiUtils";

/** Error.name of StreamGenerationError. */
export const STREAM_GENERATION_ERROR = "StreamGenerationError";

/**
 * Failure the proxy reported for the turn ({"t":"err"} chunk): a vendor error
 * mid-stream, or a durable run that failed or was lost. Final — the turn is
 * stored with this error, so there is nothing to recover. Recognise it by
 * name (STREAM_GENERATION_ERROR); instanceof breaks across module mocks.
 */
export class StreamGenerationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = STREAM_GENERATION_ERROR;
    }
}

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

/**
 * Progress of a long tool argument being written ({"t":"pg"} frame, at most
 * every 5 s while the model writes the arguments of generate_pdf, revise_pdf
 * or fs_write). Same shape as the component library's ToolProgress.
 */
export interface StreamToolProgress {
    /** Tool whose arguments are being written, e.g. "generate_pdf". */
    tool: string;
    /** Characters of arguments written so far. */
    chars: number;
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
     * accumulated so far; the preamble stays visible in the thinking flow as
     * the generator step's `reasoning`.
     */
    onContentReset?: () => void;
    /**
     * The vendor's raw finish reason for the turn (end_turn / stop / max_tokens
     * / refusal / content_filter / …). Streamed once, when generation ends —
     * lets the UI always show why it stopped, and a refusal (empty text) isn't
     * a silent blank.
     */
    onStopReason?: (reason: string) => void;
    onThinking?: (step: string) => void;
    onThinkingStep?: (step: ThinkingStep) => void;
    onThinkingDuration?: (millis: number) => void;
    onWebSources?: (sources: WebSource[]) => void;
    onGeneratedAttachments?: (attachments: AttachmentRef[]) => void;
    /** A durable run paused for human/client input — render a prompt + reply box. */
    onAwaitingInput?: (payload: AwaitingInput) => void;
    /**
     * Progress while the model writes a long tool argument (a PDF's text, a
     * scratch file): the latest "pg" frame, then null once it is over — on
     * the next content ("c"), generated-file ("ga") or error ("err") frame,
     * or when the stream ends. Live only, never persisted.
     */
    onProgress?: (progress: StreamToolProgress | null) => void;
}

/**
 * Reads an NDJSON chat stream body ({"t":"c"|"k"|"ks"|"kd"|"ws"|"ga"|"pg"|"ai"|"err"})
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

    // A "pg" progress line stays up until content, a generated file or an
    // error arrives, or the stream ends
    let progressShown = false;
    const clearProgress = () => {
        if (!progressShown) return;
        progressShown = false;
        cb.onProgress?.(null);
    };

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const msg = JSON.parse(trimmed);
            if (msg.t === "c") {
                clearProgress();
                cb.onDelta(msg.v);
            }
            else if (msg.t === "pg") {
                // Writing a long tool argument (PDF text, a scratch file)
                const v = msg.v;
                const chars = Number(v?.chars);
                if (v && typeof v === "object" && typeof v.tool === "string" && Number.isFinite(chars)) {
                    progressShown = true;
                    cb.onProgress?.({ tool: v.tool, chars });
                }
            }
            else if (msg.t === "cr") cb.onContentReset?.();
            else if (msg.t === "sr") {
                if (typeof msg.v === "string" && msg.v) cb.onStopReason?.(msg.v);
            }
            else if (msg.t === "k") cb.onThinking?.(msg.v);
            else if (msg.t === "ks") {
                // Structured per-node thinking step from the agent graph
                const step = msg.v;
                if (step && typeof step === "object" && typeof step.node === "string") {
                    cb.onThinkingStep?.(step as ThinkingStep);
                }
            }
            else if (msg.t === "kd") {
                const millis = Number(msg.v);
                if (Number.isFinite(millis)) cb.onThinkingDuration?.(millis);
            }
            else if (msg.t === "ws") {
                if (Array.isArray(msg.v) && msg.v.length > 0) cb.onWebSources?.(msg.v);
            }
            else if (msg.t === "ga") {
                clearProgress();
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
                clearProgress();
                // Vendor failure mid-stream (quota exceeded, key rejected, ...)
                // — the proxy relays the concise reason; surface it so the
                // response card shows what actually happened.
                throw new StreamGenerationError(
                    typeof msg.v === "string" && msg.v ? msg.v : "Generation failed"
                );
            }
            // other types (heartbeat, etc.) are silently ignored
        } catch (e) {
            if (e instanceof StreamGenerationError) throw e;
            // Not JSON. The proxy emits "[Error: <reason>]" as a raw line when
            // generation fails mid-stream — surface it as an error instead of
            // appending it to the generated text.
            const errorMatch = trimmed.match(/^\[Error: ([\s\S]*)\]$/);
            if (errorMatch) {
                throw new Error(errorMatch[1] || 'Stream failed');
            }
            // Other raw content (legacy format) still flows through as text
            clearProgress();
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
    } catch (error) {
        console.error("Error reading stream", error);
        throw error;
    } finally {
        // Stream over (or failed): no progress line outlives it
        clearProgress();
        reader.releaseLock();
    }
}

export async function generateTextStream(
    token: string,
    request: GenerateTextStreamRequest,
    onDelta: (chunk: string) => void,
    onMetadata?: (metadata: StreamMetadata) => void,
    onThinking?: (step: string) => void,
    signal?: AbortSignal,
    onThinkingDuration?: (millis: number) => void,
    onWebSources?: (sources: WebSource[]) => void,
    onThinkingStep?: (step: ThinkingStep) => void,
    onGeneratedAttachments?: (attachments: AttachmentRef[]) => void,
    onAwaitingInput?: (payload: AwaitingInput) => void,
    onContentReset?: () => void,
    onStopReason?: (reason: string) => void,
    onProgress?: (progress: StreamToolProgress | null) => void
): Promise<void> {
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
        try {
            const body = await response.text();
            try {
                reason = JSON.parse(body)?.error ?? '';
            } catch {
                reason = body;
            }
        } catch {
            // Body unreadable — fall back to status text only
        }
        reason = (reason || '').trim();
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
        onDelta,
        onContentReset,
        onStopReason,
        onThinking,
        onThinkingStep,
        onThinkingDuration,
        onWebSources,
        onGeneratedAttachments,
        onAwaitingInput,
        onProgress,
    });
}
