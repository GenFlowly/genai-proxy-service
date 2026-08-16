import { SavedNote } from '../../../../services/saveNotesService'

/**
 * Stale-while-revalidate store for the saved-notes list, mirroring the
 * conversation-history cache: the last known list is kept in memory (and in
 * sessionStorage to survive full page reloads), so the sidebar paints
 * instantly when the memory page opens and refreshes quietly in the
 * background.
 */

const SESSION_KEY = 'saved_notes_cache_v1'

let cache: SavedNote[] | null = null

export function loadNotesCache(): SavedNote[] | null {
    if (cache) return cache
    try {
        const raw = sessionStorage.getItem(SESSION_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
                cache = parsed
                return cache
            }
        }
    } catch {
        // sessionStorage unavailable or corrupted entry — treat as no cache
    }
    return null
}

export function saveNotesCache(notes: SavedNote[]): void {
    cache = notes
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(notes))
    } catch {
        // Best-effort persistence only
    }
}

/** Test helper / logout hook: forget everything. */
export function clearNotesCache(): void {
    cache = null
    try {
        sessionStorage.removeItem(SESSION_KEY)
    } catch {
        // ignore
    }
}
