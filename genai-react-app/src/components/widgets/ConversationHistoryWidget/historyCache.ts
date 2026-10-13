import { ConversationSummary } from '../../../models/conversationHistory.models'

/**
 * Stale-while-revalidate store for the conversation-history list, following
 * the same pattern as the AuthContext preference/instruction caches:
 * localStorage keyed per customer, so the panel paints instantly even on a
 * fresh browser session and refreshes quietly in the background. The last
 * known list is also kept in memory to skip re-parsing on every mount.
 */

export interface HistoryCacheState {
    items: ConversationSummary[]
    pinned: ConversationSummary[]
    lastKey: string | null
    hasMore: boolean
}

const KEY_SUFFIX = '_conversation_history_cache_v1'
const storageKey = (customerId: string) => `${customerId}${KEY_SUFFIX}`

let cache: HistoryCacheState | null = null
let cacheCustomerId: string | null = null

export function loadHistoryCache(customerId: string | null): HistoryCacheState | null {
    if (!customerId) return null
    if (cache && cacheCustomerId === customerId) return cache
    try {
        const raw = localStorage.getItem(storageKey(customerId))
        if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && Array.isArray(parsed.items)) {
                cache = {
                    items: parsed.items,
                    // Entries written before the Pinned feature have no pinned array
                    pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
                    lastKey: parsed.lastKey ?? null,
                    hasMore: !!parsed.hasMore,
                }
                cacheCustomerId = customerId
                return cache
            }
        }
    } catch {
        // localStorage unavailable or corrupted entry — treat as no cache
    }
    return null
}

export function saveHistoryCache(customerId: string | null, next: HistoryCacheState): void {
    if (!customerId) return
    cache = next
    cacheCustomerId = customerId
    try {
        localStorage.setItem(storageKey(customerId), JSON.stringify(next))
    } catch {
        // Best-effort persistence only
    }
}

// Session-scoped memory of which project entries are expanded, so the panel
// keeps its shape across sidebar toggles and route changes. Deliberately not
// persisted: a fresh browser session starts from the defaults again.
const expandedProjects = new Map<string, boolean>()

export function getExpandedProject(projectId: string): boolean | undefined {
    return expandedProjects.get(projectId)
}

export function setExpandedProject(projectId: string, expanded: boolean): void {
    expandedProjects.set(projectId, expanded)
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearHistoryCache(): void {
    cache = null
    cacheCustomerId = null
    expandedProjects.clear()
    try {
        Object.keys(localStorage).forEach(key => {
            if (key.endsWith(KEY_SUFFIX)) localStorage.removeItem(key)
        })
    } catch {
        // ignore
    }
}
