export interface ConversationSummary {
    conversationId: string;
    title: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    vendors?: string[];
}

export interface GetCustomerConversationsResponse {
    conversations: ConversationSummary[];
    lastEvaluatedKey: string | null;
}
