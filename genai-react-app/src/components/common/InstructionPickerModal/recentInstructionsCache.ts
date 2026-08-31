import { InstructionResponse } from '../../../models/instruction.models'

/**
 * Stale-while-revalidate store for the "recently used" instruction tiles,
 * mirroring the conversation-history and saved-notes caches: localStorage
 * keyed per customer, so the picker paints instantly even on a fresh browser
 * session and refreshes quietly in the background. The last known list is
 * also kept in memory to skip re-parsing on every open.
 */

const KEY_SUFFIX = '_recent_instructions_cache_v1'
const storageKey = (customerId: string) => `${customerId}${KEY_SUFFIX}`

let cache: InstructionResponse[] | null = null
let cacheCustomerId: string | null = null

export function loadRecentInstructionsCache(customerId: string | null): InstructionResponse[] | null {
    if (!customerId) return null
    if (cache && cacheCustomerId === customerId) return cache
    try {
        const raw = localStorage.getItem(storageKey(customerId))
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
                cache = parsed
                cacheCustomerId = customerId
                return cache
            }
        }
    } catch {
        // localStorage unavailable or corrupted entry — treat as no cache
    }
    return null
}

export function saveRecentInstructionsCache(customerId: string | null, instructions: InstructionResponse[]): void {
    if (!customerId) return
    cache = instructions
    cacheCustomerId = customerId
    try {
        localStorage.setItem(storageKey(customerId), JSON.stringify(instructions))
    } catch {
        // Best-effort persistence only
    }
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearRecentInstructionsCache(): void {
    cache = null
    cacheCustomerId = null
    try {
        Object.keys(localStorage).forEach(key => {
            if (key.endsWith(KEY_SUFFIX)) localStorage.removeItem(key)
        })
    } catch {
        // ignore
    }
}
