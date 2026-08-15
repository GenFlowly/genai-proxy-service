import { ConversationSummary } from '../../../models/conversationHistory.models'

/**
 * Stale-while-revalidate store for the conversation-history list.
 *
 * The history panel unmounts every time it's hidden (toggle, auto-hide on
 * generation, page navigation), so component state alone forces a skeleton +
 * full refetch on every appearance. This module keeps the last known list in
 * memory (and mirrors it to sessionStorage to survive full page reloads), so
 * the panel paints instantly and refreshes quietly in the background.
 */

export interface HistoryCacheState {
    items: ConversationSummary[]
    lastKey: string | null
    hasMore: boolean
}

const SESSION_KEY = 'conversation_history_cache_v1'

let cache: HistoryCacheState | null = null

export function loadHistoryCache(): HistoryCacheState | null {
    if (cache) return cache
    try {
        const raw = sessionStorage.getItem(SESSION_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && Array.isArray(parsed.items)) {
                cache = {
                    items: parsed.items,
                    lastKey: parsed.lastKey ?? null,
                    hasMore: !!parsed.hasMore,
                }
                return cache
            }
        }
    } catch {
        // sessionStorage unavailable or corrupted entry — treat as no cache
    }
    return null
}

export function saveHistoryCache(next: HistoryCacheState): void {
    cache = next
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
    } catch {
        // Best-effort persistence only
    }
}

/** Test helper / logout hook: forget everything. */
export function clearHistoryCache(): void {
    cache = null
    try {
        sessionStorage.removeItem(SESSION_KEY)
    } catch {
        // ignore
    }
}
