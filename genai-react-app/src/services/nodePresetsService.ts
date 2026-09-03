import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { GetNodePresetsResponse } from '../models/nodePresets.models'
import { fetchWithRetry } from '../utils/apiUtils'

/** Pre-made palette nodes, already sorted by sortOrder then name. */
export async function getNodePresets(token: string): Promise<GetNodePresetsResponse> {
    const response = await fetchWithRetry(endpoints.getNodePresets, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Node Presets failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetNodePresetsResponse
}
