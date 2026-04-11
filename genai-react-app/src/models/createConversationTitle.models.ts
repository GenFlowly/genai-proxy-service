export interface CreateConversationTitleRequest {
    conversationId: string;
    prompt: string;
    instructionName?: string | null;
}

export interface CreateConversationTitleResponse {
    title: string | null;
}
