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
}

export interface GetCustomerInstructionListResponse {
    instructions: InstructionResponse[];
}
