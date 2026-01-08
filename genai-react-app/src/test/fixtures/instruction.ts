import { CreateInstructionRequest, InstructionResponse, GetCustomerInstructionListResponse } from '../../models/instruction.models';

export const mockInstructionResponse: InstructionResponse = {
    id: "INS-123",
    version: 1,
    name: "Test Instruction",
    instruction: "You are a test helper."
};

export const mockCustomerInstructionListResponse: GetCustomerInstructionListResponse = {
    instructions: [
        mockInstructionResponse,
        {
            id: "INS-456",
            version: 2,
            name: "Coding Assistant",
            instruction: "You are a coding assistant."
        }
    ]
};

export const mockCreateInstructionRequest: CreateInstructionRequest = {
    instruction: "You are a new helper.",
    instructionName: "New Helper",
    existingInstructionId: null
};

export const mockUpdateInstructionRequest: CreateInstructionRequest = {
    instruction: "You are an updated helper.",
    instructionName: "Updated Helper",
    existingInstructionId: "INS-123"
};
