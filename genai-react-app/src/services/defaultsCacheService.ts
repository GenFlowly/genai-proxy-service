import { GetCustomerAgentsResponse } from '../models/agents.models'
import { GetEmbeddingModelsResponse } from './embeddingKeysService'
import { GetCustomerRequestAgentsResponse } from './requestAgentsService'
import { customerKey, StorageSuffix } from '../utils/storageKeys'

/**
 * localStorage seed envelopes for the react-query hooks in hooks/queries/*:
 * the last server response per customer, stamped with the cache version it
 * was fetched at. A hook serves the envelope WITHOUT a network call when its
 * version matches the counter from /onboard, paints it as placeholder data
 * while refetching otherwise. Fetching, dedup and in-flight sharing live in
 * react-query — this module only persists.
 */
export interface Envelope<T> {
    customerId: string
    /** Cache version the data was fetched at; null = fetched without version gating. */
    version: number | null
    data: T
}

export interface SeededCache<T> {
    getEnvelope(customerId: string): Envelope<T> | null
    save(customerId: string, data: T, version: number | null): void
}

function createSeededCache<T>(suffix: string): SeededCache<T> {
    let memory: Envelope<T> | null = null

    // Entries written before keys were per-customer lived under the bare
    // suffix; logout now clears all of localStorage, but an upgraded session
    // that never logs out would carry the orphan forever.
    try { localStorage.removeItem(suffix) } catch { /* ignore */ }

    return {
        getEnvelope(customerId: string): Envelope<T> | null {
            if (memory?.customerId === customerId) return memory
            try {
                const stored = localStorage.getItem(customerKey(customerId, suffix))
                if (stored) {
                    const parsed = JSON.parse(stored) as Envelope<T>
                    if (parsed.customerId === customerId) {
                        // Pre-versioning envelopes lack the field — normalize to
                        // null so they never satisfy a version match.
                        memory = { ...parsed, version: parsed.version ?? null }
                        return memory
                    }
                }
            } catch { /* corrupt cache — treat as empty */ }
            return null
        },

        save(customerId: string, data: T, version: number | null): void {
            memory = { customerId, version, data }
            try { localStorage.setItem(customerKey(customerId, suffix), JSON.stringify(memory)) } catch { /* quota */ }
        },
    }
}

export const requestAgentsCache = createSeededCache<GetCustomerRequestAgentsResponse>(StorageSuffix.requestAgents)
export const customerAgentsCache = createSeededCache<GetCustomerAgentsResponse>(StorageSuffix.customerAgents)
export const embeddingModelsCache = createSeededCache<GetEmbeddingModelsResponse>(StorageSuffix.embeddingModels)
