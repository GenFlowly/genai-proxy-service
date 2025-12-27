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

export interface InstructionResponseItem {
    id: string;
    name: string;
    version: number;
    instruction: string;
}

export interface GetCustomerInstructionListResponse {
    instructions: InstructionResponseItem[];
}
