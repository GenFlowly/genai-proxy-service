export interface CreateInstructionRequest {
    instruction: string;
    instructionName?: string | null;
    existingInstructionId?: string | null;
}

export interface InstructionResponse {
    id: string;
    version: number;
    name: string;
    instruction: string;
    icon?: string | null;
    color?: string | null;
    category?: string | null;
    tags?: string[] | null;
    role?: 'OWNER' | 'EDIT' | 'VIEW';
    /** When this version was saved; null for versions saved before that was kept. */
    createdAt?: string | null;
}

/** The caller's own use of an instruction. */
export interface InstructionUsageResponse {
    /** Conversations that used it, deleted ones included. */
    usageCount: number;
    lastUsedAt?: string | null;
    /** The conversations that still exist, newest first. */
    conversations: InstructionUsageConversation[];
    /** Conversations past the listing limit, not looked up. */
    omitted?: number;
}

export interface InstructionUsageConversation {
    conversationId: string;
    title?: string | null;
    firstUsedAt?: string | null;
}

export interface GetCustomerInstructionListResponse {
    instructions: InstructionResponse[];
}
