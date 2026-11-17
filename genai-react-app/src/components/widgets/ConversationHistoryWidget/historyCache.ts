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

/**
 * Rewrites the cached history of the customer this session is showing. The
 * project mutations in conversationHistoryService call it, so a project
 * renamed or deleted in one place paints right in every list seeded from
 * this cache.
 */
export function patchHistoryCache(updater: (state: HistoryCacheState) => HistoryCacheState): void {
    store.patch(updater)
}

/** The cached history with the project's new name everywhere it appears. */
export function withRenamedProject(state: HistoryCacheState, projectId: string, name: string): HistoryCacheState {
    const rename = (c: ConversationSummary) => (c.projectId === projectId ? { ...c, projectName: name } : c)
    return {
        ...state,
        items: state.items.map(rename),
        pinned: state.pinned.map(rename),
        projects: state.projects.map(p => (p.projectId === projectId ? { ...p, name } : p)),
        projectItems: Object.fromEntries(
            Object.entries(state.projectItems).map(([id, list]) => [id, list.map(rename)])
        ),
    }
}

/**
 * The cached history without the project. Its conversations stay and lose
 * the assignment, as the server unassigns them when it deletes the project.
 */
export function withoutProject(state: HistoryCacheState, projectId: string): HistoryCacheState {
    const unassign = (c: ConversationSummary) =>
        c.projectId === projectId ? { ...c, projectId: null, projectName: null } : c
    const projectItems = { ...state.projectItems }
    delete projectItems[projectId]
    return {
        ...state,
        items: state.items.map(unassign),
        pinned: state.pinned.map(unassign),
        projects: state.projects.filter(p => p.projectId !== projectId),
        projectItems,
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
