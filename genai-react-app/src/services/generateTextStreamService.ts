import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { GenerateTextStreamRequest } from "../models/generateText.models";

export interface StreamMetadata {
    conversationId: string | null;
    messageId: string | null;
    responseMessageId: string | null;
    aiVendor: string | null;
}

export async function generateTextStream(
    token: string,
    request: GenerateTextStreamRequest,
    onDelta: (chunk: string) => void,
    onMetadata?: (metadata: StreamMetadata) => void
): Promise<void> {
    const response = await fetch(endpoints.generateTextStream, {
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

    if (onMetadata) {
        onMetadata({
            conversationId: conversationId,
            messageId: messageId,
            responseMessageId: responseMessageId,
            aiVendor: aiVendor
        });
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder("utf-8");

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            onDelta(chunk);
        }
    } catch (error) {
        console.error("Error reading stream", error);
        throw error;
    } finally {
        reader.releaseLock();
    }
}
