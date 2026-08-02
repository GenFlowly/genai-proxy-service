import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import {
    CreateInstructionRequest,
    GetCustomerInstructionListResponse,
    InstructionResponse
} from "../models/instruction.models";

import { fetchWithRetry } from "../utils/apiUtils";

export async function getCustomerInstructions(token: string): Promise<GetCustomerInstructionListResponse> {
    const response = await fetchWithRetry(endpoints.getCustomerInstructions, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Instructions failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetCustomerInstructionListResponse
}

export async function createInstruction(
    token: string,
    request: CreateInstructionRequest
): Promise<InstructionResponse> {
    const response = await fetchWithRetry(endpoints.createInstruction, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    })

    if (!response.ok) {
        throw new Error(`Create Instruction failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as InstructionResponse
}



// ... (existing code)

export async function getInstructionVersion(
    token: string,
    instructionId: string,
    version: number
): Promise<InstructionResponse> {
    // Use the same endpoint base as createInstruction, but GET with params
    // Route: /api/v1/instruction/{instructionId}/{version}
    const url = `${endpoints.createInstruction}/${instructionId}/${version}`

    const response = await fetchWithRetry(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Instruction Version failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as InstructionResponse
}

export async function shareInstruction(
    token: string,
    instructionId: string,
    targetCustomerId: string
): Promise<void> {
    const response = await fetchWithRetry(`${endpoints.createInstruction}/share`, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ instructionId, targetCustomerId }),
    })

    if (!response.ok) {
        throw new Error(`Share Instruction failed: ${response.status} ${response.statusText}`)
    }
}

export async function deleteInstruction(
    token: string,
    instructionId: string
): Promise<void> {
    const response = await fetchWithRetry(`${endpoints.createInstruction}/${instructionId}`, {
        method: HttpMethod.DELETE,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Delete Instruction failed: ${response.status} ${response.statusText}`)
    }
}
