import { endpoints } from '../config/endpoints'
import {
    CreateInstructionRequest,
    InstructionResponse,
} from '../models/instructions.models'

export async function createInstruction(
    token: string,
    request: CreateInstructionRequest
): Promise<InstructionResponse> {
    const response = await fetch(endpoints.createInstruction, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    })

    if (!response.ok) {
        throw new Error(`Create instruction failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
}

/**
 * Make an instruction public. The backend models public visibility as a
 * share with the literal "PUBLIC" customer.
 */
export async function shareInstructionPublic(
    token: string,
    instructionId: string,
    role: 'VIEW' | 'EDIT' = 'VIEW'
): Promise<void> {
    const response = await fetch(endpoints.shareInstruction, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            instructionId,
            targetCustomerId: 'PUBLIC',
            role,
        }),
    })

    if (!response.ok) {
        throw new Error(`Making instruction public failed: ${response.status} ${response.statusText}`)
    }
}
