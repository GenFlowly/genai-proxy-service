export interface CreateInstructionRequest {
    instruction: string;
    instructionName: string;
    existingInstructionId?: string | null;
}

export interface CreateInstructionResponse {
    id: string;
    version: number;
    name: string;
}
