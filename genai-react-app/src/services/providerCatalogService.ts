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

const CATALOG_STORAGE_KEY = 'provider_catalog_cache'

let catalogCache: ProviderCatalogResponse | null = null
let fetchedThisSession = false
let inFlight: Promise<ProviderCatalogResponse> | null = null
const listeners = new Set<() => void>()

export function subscribeProviderCatalog(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/**
 * Last known catalog: this session's fetch, else the previous session's
 * copy from localStorage (refreshed once the session's fetch lands). Null
 * only before the very first successful fetch on this browser.
 */
export function getCachedProviderCatalog(): ProviderCatalogResponse | null {
    if (catalogCache) return catalogCache
    try {
        const stored = localStorage.getItem(CATALOG_STORAGE_KEY)
        if (stored) catalogCache = JSON.parse(stored) as ProviderCatalogResponse
    } catch { /* ignore corrupt cache */ }
    return catalogCache
}

/**
 * BYOK vendor catalog: every provider the platform can call. Static per
 * backend deploy, so one successful fetch per session refreshes the cache;
 * concurrent callers share the in-flight request.
 */
export async function getProviderCatalog(token: string): Promise<ProviderCatalogResponse> {
    if (fetchedThisSession && catalogCache) return catalogCache
    if (inFlight) return inFlight

    inFlight = (async () => {
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
        if (parsed.providers.length > 0) {
            catalogCache = parsed
            fetchedThisSession = true
            try { localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(parsed)) } catch { /* quota */ }
            listeners.forEach(l => l())
        }
        return parsed
    })()

    try {
        return await inFlight
    } finally {
        inFlight = null
    }
}
