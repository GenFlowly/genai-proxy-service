import { HttpMethod } from "../constants/http";
import { endpoints } from "../config/endpoints";
import {
    CreateInstructionRequest,
    GetCustomerInstructionListResponse,
    InstructionResponse,
    InstructionUsageResponse,
} from "../models/instruction.models";

import { fetchWithRetry } from "../utils/apiUtils";
import { searchErrorFrom } from "./searchError";
import { SearchUserResponse } from "../models/user.models";
import { removeInstruction, upsertInstruction } from "../stores/instructionsStore";

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

export async function searchInstructions(token: string, query: string): Promise<GetCustomerInstructionListResponse> {
    const url = `${endpoints.searchInstructions}?q=${encodeURIComponent(query)}`
    const response = await fetchWithRetry(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await searchErrorFrom(response, 'Search Instructions failed')
    }

    return (await response.json()) as GetCustomerInstructionListResponse
}

export async function getRecentInstructions(token: string, limit = 3): Promise<GetCustomerInstructionListResponse> {
    const response = await fetchWithRetry(`${endpoints.getRecentInstructions}?limit=${limit}`, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Recent Instructions failed: ${response.status} ${response.statusText}`)
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

    const created = (await response.json()) as InstructionResponse
    // Write-through: the local instruction list updates here, with the
    // successful call — call sites never mirror it ad hoc.
    upsertInstruction(created)
    return created
}



// ... (existing code)

export async function shareInstruction(
    token: string,
    instructionId: string,
    targetCustomerId: string,
    role: 'VIEW' | 'EDIT' = 'VIEW'
): Promise<void> {
    const response = await fetchWithRetry(`${endpoints.createInstruction}/share`, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ instructionId, targetCustomerId, role }),
    })

    if (!response.ok) {
        throw new Error(`Share Instruction failed: ${response.status} ${response.statusText}`)
    }
}

export async function unshareInstruction(
    token: string,
    instructionId: string,
    targetCustomerId: string
): Promise<void> {
    const response = await fetchWithRetry(`${endpoints.createInstruction}/share?instructionId=${instructionId}&targetCustomerId=${targetCustomerId}`, {
        method: HttpMethod.DELETE,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Unshare Instruction failed: ${response.status} ${response.statusText}`)
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

    removeInstruction(instructionId)
}

export async function getInstructionSharedUsers(
    token: string,
    instructionId: string
): Promise<SearchUserResponse[]> {
    const response = await fetchWithRetry(`${endpoints.createInstruction}/shared?instructionId=${encodeURIComponent(instructionId)}`, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Shared Users failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as SearchUserResponse[]
}

export class InstructionApiError extends Error {
    constructor(readonly status: number) {
        super(`Instruction request failed: ${status}`)
    }
}

/** In how many of the caller's conversations the instruction was used, when last, and which. */
export async function getInstructionUsage(token: string, instructionId: string): Promise<InstructionUsageResponse> {
    const response = await fetchWithRetry(endpoints.instructionUsage(instructionId), {
        method: HttpMethod.GET,
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new InstructionApiError(response.status)
    return (await response.json()) as InstructionUsageResponse
}
