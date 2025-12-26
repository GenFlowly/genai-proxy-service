export interface CreateInstructionRequest {
    instruction: string;
    instructionName?: string | null;
    existingInstructionId?: string | null;
}

export interface CreateInstructionResponse {
    id: string;
    version: number;
    name: string;
}
