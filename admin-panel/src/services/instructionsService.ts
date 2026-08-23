import { endpoints } from '../config/endpoints'
import {
    CreateInstructionRequest,
    GetCustomerInstructionListResponse,
    InstructionResponse,
} from '../models/instructions.models'

export async function getCustomerInstructions(
    token: string
): Promise<GetCustomerInstructionListResponse> {
    const response = await fetch(endpoints.getCustomerInstructions, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get instructions failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
}

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

export async function deleteInstruction(token: string, instructionId: string): Promise<void> {
    const response = await fetch(`${endpoints.createInstruction}/${instructionId}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Delete instruction failed: ${response.status} ${response.statusText}`)
    }
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
