export interface ConversationSummary {
    conversationId: string;
    title: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface GetCustomerConversationsResponse {
    conversations: ConversationSummary[];
    lastEvaluatedKey: string | null;
}
