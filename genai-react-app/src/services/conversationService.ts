import { ConversationBlock } from "../models/conversation.models";

export interface GetConversationResponse {
    conversationId: string;
    blocks: ConversationBlock[];
}

export async function getConversation(
    token: string,
    conversationId: string
): Promise<GetConversationResponse> {

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
