import { ConversationSummary, Project } from '../../../models/conversationHistory.models'
import { createCustomerCache } from '../../../utils/customerListCache'
import { StorageSuffix } from '../../../utils/storageKeys'

export interface HistoryCacheState {
    items: ConversationSummary[]
    pinned: ConversationSummary[]
    lastKey: string | null
    hasMore: boolean
    projects: Project[]
    // Per-project member lists from GET /projects/conversations, keyed by
    // projectId — fetched lazily when a project expands, cached so the next
    // session paints the expanded project instantly
    projectItems: Record<string, ConversationSummary[]>
}

const store = createCustomerCache<HistoryCacheState>(StorageSuffix.conversationHistory, parsed => {
    const p = parsed as Partial<HistoryCacheState> | null
    if (!p || !Array.isArray(p.items)) return null
    return {
        items: p.items,
        // Entries written before the Pinned/Projects features lack these arrays
        pinned: Array.isArray(p.pinned) ? p.pinned : [],
        lastKey: p.lastKey ?? null,
        hasMore: !!p.hasMore,
        projects: Array.isArray(p.projects) ? p.projects : [],
        projectItems: p.projectItems && typeof p.projectItems === 'object' && !Array.isArray(p.projectItems)
            ? p.projectItems
            : {},
    }
})

export function loadHistoryCache(customerId: string | null): HistoryCacheState | null {
    return store.load(customerId)
}

export function saveHistoryCache(customerId: string | null, next: HistoryCacheState): void {
    store.save(customerId, next)
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

// Same idea for the panel's own top-level sections (Projects, Pinned,
// Recents): remembers whether the user collapsed one, for the rest of the
// session.
const expandedSections = new Map<string, boolean>()

export function getExpandedSection(sectionId: string): boolean | undefined {
    return expandedSections.get(sectionId)
}

export function setExpandedSection(sectionId: string, expanded: boolean): void {
    expandedSections.set(sectionId, expanded)
}

/** Logout hook / test helper: forget everything, for every customer. */
export function clearHistoryCache(): void {
    store.clear()
    expandedProjects.clear()
    expandedSections.clear()
}
