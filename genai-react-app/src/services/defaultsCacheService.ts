import { getCustomerAgents } from './agentsService'
import { getEmbeddingModels } from './embeddingKeysService'
import { getRequestAgents } from './requestAgentsService'
import { getProviderCatalog } from './providerCatalogService'

/**
 * Cached reads for the Settings → Defaults page, in the providerCatalogService
 * mold (memory + localStorage, shared in-flight request). Unlike the provider
 * catalog this data is per-customer and user-mutable, so the cache is only a
 * render seed: getCached() shows the last known state instantly, and every
 * fetch() still goes to the server and refreshes the cache — stale data never
 * outlives one revalidation.
 */
export interface CachedResource<T> {
    /** Last stored response for this customer (memory, else localStorage), or null. */
    getCached(customerId: string): T | null
    /** Fetch from the server and refresh the cache; concurrent callers share one request. */
    fetch(token: string, customerId: string): Promise<T>
}

/** The stored shape carries the owning customer so another login never sees it. */
interface Envelope<T> {
    customerId: string
    data: T
}

function createCachedResource<T>(
    storageKey: string,
    fetcher: (token: string) => Promise<T>
): CachedResource<T> {
    let memory: Envelope<T> | null = null
    let inFlight: { customerId: string; promise: Promise<T> } | null = null

    return {
        getCached(customerId: string): T | null {
            if (memory?.customerId === customerId) return memory.data
            try {
                const stored = localStorage.getItem(storageKey)
                if (stored) {
                    const parsed = JSON.parse(stored) as Envelope<T>
                    if (parsed.customerId === customerId) {
                        memory = parsed
                        return parsed.data
                    }
                }
            } catch { /* corrupt cache — treat as empty */ }
            return null
        },

        async fetch(token: string, customerId: string): Promise<T> {
            if (inFlight?.customerId === customerId) return inFlight.promise
            const promise = (async () => {
                const data = await fetcher(token)
                memory = { customerId, data }
                try { localStorage.setItem(storageKey, JSON.stringify(memory)) } catch { /* quota */ }
                return data
            })()
            inFlight = { customerId, promise }
            try {
                return await promise
            } finally {
                inFlight = null
            }
        },
    }
}

export const requestAgentsCache = createCachedResource('request_agents_cache', getRequestAgents)
export const customerAgentsCache = createCachedResource('customer_agents_cache', getCustomerAgents)
export const embeddingModelsCache = createCachedResource('embedding_models_cache', getEmbeddingModels)

/**
 * Warm everything the Defaults page reads (request-agent mappings, the
 * customer's agents, the probed embedding-model catalog, and the provider
 * display-name catalog) so the page renders fully populated on first visit.
 * Best-effort: individual failures are swallowed — the page's own load
 * handles errors with the user watching.
 */
export async function prefetchDefaultsPageData(token: string, customerId: string): Promise<void> {
    await Promise.allSettled([
        requestAgentsCache.fetch(token, customerId),
        customerAgentsCache.fetch(token, customerId),
        embeddingModelsCache.fetch(token, customerId),
        getProviderCatalog(token),
    ])
}
