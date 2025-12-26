import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import {
    CreateInstructionRequest,
    CreateInstructionResponse
} from "../models/instruction.models";

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
