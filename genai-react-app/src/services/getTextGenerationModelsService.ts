import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    GetTextGenerationModelsRequest,
    GetTextGenerationModelsResponse,
} from '../models/getTextGenerationModels.models'
import { fetchWithRetry } from "../utils/apiUtils";

export async function getTextGenerationModels(
    token: string,
    customerId: string,
    request: GetTextGenerationModelsRequest
): Promise<GetTextGenerationModelsResponse> {
    const response = await fetchWithRetry(endpoints.getTextGenerationModels, {
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
