import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'

// Mirrors genai-proxy-server models/api/ProviderCatalog.kt

export interface ProviderModelInfo {
    name: string
    /** False = agentic features (tools) may degrade on this model */
    supportsTools: boolean
}

export interface ProviderInfo {
    /** Canonical provider id (LiteLLM id; legacy vendors map server-side) */
    id: string
    displayName: string
    /** True = first-party langchain integration; false = LiteLLM path */
    native: boolean
    models: ProviderModelInfo[]
}

export interface ProviderCatalogResponse {
    providers: ProviderInfo[]
}

let catalogCache: ProviderCatalogResponse | null = null

/**
 * BYOK vendor catalog: every provider the platform can call. Static per
 * backend deploy, so one successful fetch is cached for the session.
 */
export async function getProviderCatalog(token: string): Promise<ProviderCatalogResponse> {
    if (catalogCache) return catalogCache

    const response = await fetchWithRetry(endpoints.getProviders, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get provider catalog failed: ${response.status} ${response.statusText}`)
    }

    const parsed = (await response.json()) as ProviderCatalogResponse
    if (parsed.providers.length > 0) catalogCache = parsed
    return parsed
}
