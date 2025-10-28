import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { AIVendor } from '../constants/vendors'

export interface GetTextGenerationModelsRequest {
    vendor: AIVendor
    customerId: string
}

export interface GetTextGenerationModelsResponse {
    vendor: AIVendor
    modelsList: string[]
}

export async function getTextGenerationModels(
    token: string,
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

    return (await response.json()) as GetTextGenerationModelsResponse
}
