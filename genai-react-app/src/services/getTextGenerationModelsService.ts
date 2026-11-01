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
    // Pure read: vendors travel as a query param. The backend keeps a
    // deprecated POST-with-body variant until no deployed client sends it.
    const url = `${endpoints.getTextGenerationModels}?vendors=${encodeURIComponent(request.aiVendor.join(','))}`
    const response = await fetchWithRetry(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as GetTextGenerationModelsResponse
    return data
}
