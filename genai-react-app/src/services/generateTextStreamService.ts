import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { GenerateTextStreamRequest } from "../models/generateText.models";
import { ThinkingStep, WebSource } from "../models/conversation.models";
import { fetchWithRetry } from "../utils/apiUtils";

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

// Sentinel logic removed; token usage is explicitly queried after the stream.
// TITLE_SENTINEL_RE removed due to async title generation migration

export async function generateTextStream(
    token: string,
    request: GenerateTextStreamRequest,
    onDelta: (chunk: string) => void,
    onMetadata?: (metadata: StreamMetadata) => void,
    onThinking?: (step: string) => void,
    signal?: AbortSignal,
    onThinkingDuration?: (millis: number) => void,
    onWebSources?: (sources: WebSource[]) => void,
    onThinkingStep?: (step: ThinkingStep) => void
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

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder("utf-8");
    let lineBuffer = "";

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const msg = JSON.parse(trimmed);
            if (msg.t === "c") onDelta(msg.v);
            else if (msg.t === "k") onThinking?.(msg.v);
            else if (msg.t === "ks") {
                // Structured per-node thinking step from the agent graph
                const step = msg.v;
                if (step && typeof step === "object" && typeof step.node === "string") {
                    onThinkingStep?.(step as ThinkingStep);
                }
            }
            else if (msg.t === "kd") {
                const millis = Number(msg.v);
                if (Number.isFinite(millis)) onThinkingDuration?.(millis);
            }
            else if (msg.t === "ws") {
                if (Array.isArray(msg.v) && msg.v.length > 0) onWebSources?.(msg.v);
            }
            // other types (heartbeat, etc.) are silently ignored
        } catch {
            // Not JSON. The proxy emits "[Error: <reason>]" as a raw line when
            // generation fails mid-stream — surface it as an error instead of
            // appending it to the generated text.
            const errorMatch = trimmed.match(/^\[Error: ([\s\S]*)\]$/);
            if (errorMatch) {
                throw new Error(errorMatch[1] || 'Stream failed');
            }
            // Other raw content (legacy format) still flows through as text
            onDelta(line);
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
        reader.releaseLock();
    }
}
