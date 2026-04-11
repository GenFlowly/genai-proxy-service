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

/**
 * Sentinel emitted by the server at the very end of a stream when token usage is available.
 * Format: "\n[USAGE:{\"inputTokens\":N,\"outputTokens\":N}]"
 */
const USAGE_SENTINEL_RE = /\n\[USAGE:(\{[^}]+\})\]$/;

/**
 * Sentinel emitted at the very START of a stream for new conversations.
 * Format: "[TITLE:My Conversation Title]"
 * Note: no ^ anchor — the backend emits a heartbeat space before the flow,
 * so the sentinel may not be at position 0 of the first received chunk.
 */
const TITLE_SENTINEL_RE = /\[TITLE:([^\]]+)\]/;

export async function generateTextStream(
    token: string,
    request: GenerateTextStreamRequest,
    onDelta: (chunk: string) => void,
    onMetadata?: (metadata: StreamMetadata) => void
): Promise<void> {
    const response = await fetchWithRetry(endpoints.generateTextStream, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    });

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
    let accumulated = "";
    let titleExtracted = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            let chunk = decoder.decode(value, { stream: true });

            // Check for TITLE sentinel only in the first chunk (new conversations)
            if (!titleExtracted) {
                const titleMatch = chunk.match(TITLE_SENTINEL_RE);
                if (titleMatch) {
                    titleExtracted = true;
                    try {
                        const title = titleMatch[1].trim();
                        document.title = `${title} | Genflowly`;
                        if (onMetadata) {
                            onMetadata({
                                conversationId, messageId, responseMessageId, aiVendor,
                                inputTokens: null, outputTokens: null, totalTokens: null,
                                tokensReadFromCache: null,
                                conversationTitle: title
                            });
                        }
                    } catch {
                        console.warn("Failed to parse TITLE sentinel:", titleMatch[1]);
                    }
                    // Strip sentinel from chunk before forwarding
                    chunk = chunk.replace(TITLE_SENTINEL_RE, "");
                }
            }

            accumulated += chunk;

            // Check if the accumulated buffer ends with the USAGE sentinel.
            // If so, strip it before forwarding to the caller.
            const match = accumulated.match(USAGE_SENTINEL_RE);
            if (match) {
                // Strip sentinel from accumulated and emit only clean text
                const cleanChunk = chunk.replace(USAGE_SENTINEL_RE, "");
                accumulated = accumulated.replace(USAGE_SENTINEL_RE, "");

                if (cleanChunk.length > 0) onDelta(cleanChunk);

                // Parse usage and fire a second onMetadata call with token counts
                try {
                    const usage = JSON.parse(match[1]) as {
                        inputTokens?: number | null;
                        outputTokens?: number | null;
                        totalTokens?: number | null;
                        tokensReadFromCache?: number | null;
                    };
                    if (onMetadata) {
                        onMetadata({
                            conversationId,
                            messageId,
                            responseMessageId,
                            aiVendor,
                            inputTokens: usage.inputTokens ?? null,
                            outputTokens: usage.outputTokens ?? null,
                            totalTokens: usage.totalTokens ?? null,
                            tokensReadFromCache: usage.tokensReadFromCache ?? null,
                        });
                    }
                } catch {
                    console.warn("Failed to parse USAGE sentinel:", match[1]);
                }
            } else {
                onDelta(chunk);
            }
        }
    } catch (error) {
        console.error("Error reading stream", error);
        throw error;
    } finally {
        reader.releaseLock();
    }
}
