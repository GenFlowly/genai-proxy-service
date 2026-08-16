export interface CreateInstructionRequest {
    instruction: string
    instructionName?: string
    existingInstructionId?: string
}

export interface InstructionResponse {
    id: string
    name: string
    version: number
    instruction: string
    icon?: string | null
    color?: string | null
    tags?: string[] | null
    category?: string | null
    role?: string
}
