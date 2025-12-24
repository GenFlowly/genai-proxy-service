import { config } from '../config/env';
import { ConversationBlock, Message } from '../models/conversation.models';
import { AIVendor } from '../constants/vendors';

// Backend types matching Kotlin data classes
interface BackendPrompt {
    systemPrompt: string;
    prompt: string;
}

interface BackendResponse {
    text: string | null;
    aiVendor: string | null;
    conversationId: string | null;
    messageId: string | null;
}

interface BackendPromptAndResponse {
    prompt: BackendPrompt;
    response: BackendResponse;
}

interface BackendGetConversationResponse {
    promptAndResponseList: BackendPromptAndResponse[];
}

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
}

export async function getConversation(
    token: string,
    conversationId: string
): Promise<GetConversationResponse> {

    const url = `${config.backend.baseUrl}/api/v1/chat/${conversationId}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch conversation: ${response.status} ${response.statusText}`);
    }

    const data: BackendGetConversationResponse = await response.json();

    const blocks: ConversationBlock[] = data.promptAndResponseList.map((item, index) => {
        const responses: Message[] = [];

        // Only map if we have minimal valid response data
        if (item.response && item.response.text) {
            // Map backend vendor string to frontend Enum if possible, default to something safe or keep string
            const vendor = (item.response.aiVendor as AIVendor) || AIVendor.OPENAI;

            responses.push({
                aiVendor: vendor,
                text: item.response.text,
                messageId: item.response.messageId || `msg-${index}`,
            });
        }

        return {
            // Use messageId for block ID if available to be stable, otherwise index
            conversationBlockId: item.response.messageId ? `block-${item.response.messageId}` : `block-${index}-${Date.now()}`,
            prompt: item.prompt.prompt,
            responseMessages: responses,
            isLoading: false
        };
    });

    return {
        conversationId,
        blocks
    };
}
