import { fetchWithRetry } from "../utils/apiUtils";
import { config } from '../config/env';
import { ConversationBlock, Message } from '../models/conversation.models';
import { AIVendor } from '../constants/vendors';

// Backend types matching Kotlin data classes
interface BackendPrompt {
    instructionId: string;
    instructionVersion: string;
    prompt: string;
}

interface BackendResponse {
    text: string | null;
    aiVendor: string | null;
    conversationId: string | null;
    messageId: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    tokensReadFromCache?: number | null;
}

interface BackendPromptAndResponse {
    prompt: BackendPrompt;
    responses?: BackendResponse[];
}

interface BackendGetConversationResponse {
    promptAndResponseList: BackendPromptAndResponse[];
    title?: string | null;
}

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
    title?: string | null;
}

export async function getConversation(
    token: string,
    conversationId: string
): Promise<GetConversationResponse | null> { // Changed return type to include null

    const url = `${config.backend.baseUrl}/api/v1/chat/${conversationId}`;

    const response = await fetchWithRetry(url, { // Changed to fetchWithRetry
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        const err = new Error(`Failed to fetch conversation: ${response.status} ${response.statusText}`) as Error & { status: number }
        err.status = response.status
        throw err
    }

    const data: BackendGetConversationResponse = await response.json();

    const blocks: ConversationBlock[] = data.promptAndResponseList.map((item, index) => {
        const responses: Message[] = [];

        const responsesToProcess = item.responses && item.responses.length > 0 
            ? item.responses 
            : [];

        responsesToProcess.forEach((resp, respIndex) => {
            // Only map if we have minimal valid response data
            if (resp && resp.text) {
                // Map backend vendor string to frontend Enum if possible, default to something safe or keep string
                const vendor = (resp.aiVendor as AIVendor) || AIVendor.OPENAI;

                responses.push({
                    aiVendor: vendor,
                    text: resp.text,
                    messageId: resp.messageId || `msg-${index}-${respIndex}`,
                    inputTokens: resp.inputTokens ?? null,
                    outputTokens: resp.outputTokens ?? null,
                    totalTokens: resp.totalTokens ?? null,
                    tokensReadFromCache: resp.tokensReadFromCache ?? null,
                });
            }
        });

        return {
            // Use messageId for block ID if available to be stable, otherwise index
            conversationBlockId: item.responses && item.responses.length > 0 && item.responses[0].messageId 
                ? `block-${item.responses[0].messageId}` 
                : `block-${index}-${Date.now()}`,
            prompt: item.prompt.prompt,
            responseMessages: responses,
            isLoading: false,
            status: 'resolved'
        };
    });

    return {
        conversationId,
        blocks,
        title: data.title ?? null
    };
}
