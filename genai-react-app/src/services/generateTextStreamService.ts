import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { GenerateTextStreamRequest } from "../models/generateText.models";
import { fetchWithRetry } from "../utils/apiUtils";

export interface StreamMetadata {
    conversationId: string | null;
    messageId: string | null;
    responseMessageId: string | null;
    aiVendor: string | null;
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
    signal?: AbortSignal
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
        throw new Error(`Text generation failed: ${response.status} ${response.statusText}`);
    }

    const conversationId = response.headers.get("X-Conversation-Id");
    const messageId = response.headers.get("X-Message-Id");
    const responseMessageId = response.headers.get("X-Response-Message-Id");
    const aiVendor = response.headers.get("X-Ai-Vendor");

    // Call onMetadata immediately with header-based fields (tokens arrive later via sentinel)
    if (onMetadata) {
        onMetadata({
            conversationId,
            messageId,
            responseMessageId,
            aiVendor,
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
            // other types (heartbeat, etc.) are silently ignored
        } catch {
            // Not JSON — treat as raw content (error messages, legacy format)
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
