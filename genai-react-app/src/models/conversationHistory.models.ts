export interface ConversationSummary {
    conversationId: string;
    title: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    pinnedAt?: string | null;
    vendors?: string[];
}

export interface GetCustomerConversationsResponse {
    conversations: ConversationSummary[];
    lastEvaluatedKey: string | null;
}

export interface GetPinnedConversationsResponse {
    conversations: ConversationSummary[];
}
