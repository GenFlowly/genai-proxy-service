import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    GetTextGenerationModelsRequest,
    GetTextGenerationModelsResponse,
} from '../models/getTextGenerationModels.models'

export function clearModelCache(customerId: string): void {
    // No-op
}

export function clearAllModelCache(): void {
    // No-op
}

export function getModelCacheStats() {
    return { count: 0, size: 0 }
}

export async function getTextGenerationModels(
    token: string,
    customerId: string,
    request: GetTextGenerationModelsRequest
): Promise<GetTextGenerationModelsResponse> {
    const response = await fetch(endpoints.getTextGenerationModels, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as GetTextGenerationModelsResponse
    return data
}
