import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import { ConversationBlock } from "../models/conversation.models";

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
}

export async function getConversation(
    token: string,
    conversationId: string
): Promise<GetConversationResponse> {
    console.log(`[STUB] Fetching conversation ${conversationId} with token ${token.substring(0, 10)}...`)

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500))

    // Return dummy data
    return {
        conversationId,
        blocks: [
            {
                conversationBlockId: 'stub-block-1',
                prompt: '',
                responseMessages: [],
                isLoading: false
            }
        ]
    }
}
