import { SavedNote } from '../../../../services/saveNotesService'

/**
 * Stale-while-revalidate store for the saved-notes list, mirroring the
 * conversation-history cache: localStorage keyed per customer, so the sidebar
 * paints instantly even on a fresh browser session and refreshes quietly in
 * the background. The last known list is also kept in memory to skip
 * re-parsing on every mount.
 */

const KEY_SUFFIX = '_saved_notes_cache_v1'
const storageKey = (customerId: string) => `${customerId}${KEY_SUFFIX}`

let cache: SavedNote[] | null = null
let cacheCustomerId: string | null = null

export function loadNotesCache(customerId: string | null): SavedNote[] | null {
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

export function saveNotesCache(customerId: string | null, notes: SavedNote[]): void {
    if (!customerId) return
    cache = notes
    cacheCustomerId = customerId
    try {
        localStorage.setItem(storageKey(customerId), JSON.stringify(notes))
    } catch {
        // Best-effort persistence only
    }
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearNotesCache(): void {
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
