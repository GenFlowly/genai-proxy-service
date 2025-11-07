import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { AIVendor } from '../constants/vendors'
import { CacheManager } from '../utils/cache'
import {
    GetTextGenerationModelsRequest,
    GetTextGenerationModelsResponse,
} from '../models/getTextGenerationModels.models'

const modelCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    prefix: 'ai_models_',
})

function getCacheKey(customerId: string): string {
    return `models_${customerId}`
}

export async function getTextGenerationModels(
    token: string,
    request: GetTextGenerationModelsRequest,
    bypassCache: boolean = false
): Promise<GetTextGenerationModelsResponse> {
    const { customerId } = request
    const cacheKey = getCacheKey(customerId)

    if (!bypassCache) {
        const cached = modelCache.get<GetTextGenerationModelsResponse>(cacheKey)
        if (cached) {
            console.log(`✅ Using cached models for all vendors (customer ${customerId})`)
            return cached
        }
    }

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

    // Save to cache
    modelCache.set(cacheKey, data)

    return data
}

export function clearModelCache(customerId: string): void {
    modelCache.delete(getCacheKey(customerId))
}

export function clearAllModelCache(): void {
    modelCache.clear()
}

export function getModelCacheStats() {
    return modelCache.getStats()
}
