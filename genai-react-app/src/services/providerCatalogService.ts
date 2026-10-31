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

// Platform-wide catalog, identical for every customer — one of the few
// deliberately global localStorage keys (see utils/storageKeys.ts). Session
// caching, dedup and once-per-session semantics live in useProviderCatalog;
// this module only fetches and persists.
const CATALOG_STORAGE_KEY = 'provider_catalog_cache'

let memoryCache: ProviderCatalogResponse | null = null

/** Last known catalog from a previous session (memory, else localStorage). */
export function getCachedProviderCatalog(): ProviderCatalogResponse | null {
    if (memoryCache) return memoryCache
    try {
        const stored = localStorage.getItem(CATALOG_STORAGE_KEY)
        if (stored) memoryCache = JSON.parse(stored) as ProviderCatalogResponse
    } catch { /* ignore corrupt cache */ }
    return memoryCache
}

export function saveProviderCatalog(catalog: ProviderCatalogResponse): void {
    memoryCache = catalog
    try { localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(catalog)) } catch { /* quota */ }
}

export async function fetchProviderCatalog(token: string): Promise<ProviderCatalogResponse> {
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

    return (await response.json()) as ProviderCatalogResponse
}
