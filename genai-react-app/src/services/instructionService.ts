import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import {
    CreateInstructionRequest,
    CreateInstructionResponse,
    GetCustomerInstructionListResponse,
    InstructionResponseItem
} from "../models/instruction.models";

export async function getCustomerInstructions(token: string): Promise<GetCustomerInstructionListResponse> {
    const response = await fetch(endpoints.getCustomerInstructions, {
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
): Promise<CreateInstructionResponse> {
    const response = await fetch(endpoints.createInstruction, {
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

    return (await response.json()) as CreateInstructionResponse
}



// ... (existing code)

export async function getInstructionVersion(
    token: string,
    instructionId: string,
    version: number
): Promise<InstructionResponseItem> {
    // Use the same endpoint base as createInstruction, but GET with params
    // Route: /api/v1/instruction/{instructionId}/{version}
    const url = `${endpoints.createInstruction}/${instructionId}/${version}`

    const response = await fetch(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Instruction Version failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as InstructionResponseItem
}
