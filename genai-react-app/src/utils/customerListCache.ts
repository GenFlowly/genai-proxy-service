import { customerKey } from './storageKeys'

/**
 * Stale-while-revalidate localStorage store, one instance per cached list
 * (conversation history, memories, recent instructions): keyed per
 * customer so the UI paints instantly on a fresh session, with the last
 * known value mirrored in memory to skip re-parsing on every mount. This is
 * a render seed only — callers always refetch and save() the fresh result.
 */
export interface CustomerCache<T> {
    load(customerId: string | null): T | null
    save(customerId: string | null, value: T): void
    /** Forget everything, for every customer — memory AND localStorage. */
    clear(): void
}

export function createCustomerCache<T>(
    suffix: string,
    /** Returns the normalized value, or null when the stored shape is unusable. */
    validate: (parsed: unknown) => T | null
): CustomerCache<T> {
    let cache: T | null = null
    let cacheCustomerId: string | null = null

    return {
        load(customerId: string | null): T | null {
            if (!customerId) return null
            if (cache !== null && cacheCustomerId === customerId) return cache
            try {
                const raw = localStorage.getItem(customerKey(customerId, suffix))
                if (raw) {
                    const validated = validate(JSON.parse(raw))
                    if (validated !== null) {
                        cache = validated
                        cacheCustomerId = customerId
                        return cache
                    }
                }
            } catch {
                // localStorage unavailable or corrupted entry — treat as no cache
            }
            return null
        },

        save(customerId: string | null, value: T): void {
            if (!customerId) return
            cache = value
            cacheCustomerId = customerId
            try {
                localStorage.setItem(customerKey(customerId, suffix), JSON.stringify(value))
            } catch {
                // Best-effort persistence only
            }
        },

        clear(): void {
            cache = null
            cacheCustomerId = null
            try {
                Object.keys(localStorage).forEach(key => {
                    if (key.endsWith(`_${suffix}`)) localStorage.removeItem(key)
                })
            } catch {
                // ignore
            }
        },
    }
}
