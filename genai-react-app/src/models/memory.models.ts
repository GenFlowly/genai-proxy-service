export type MemoryKind = 'CORE' | 'EPISODIC'

export type MemorySourceType = 'CONVERSATION' | 'NOTE' | 'USER'

/** Where a memory applies: a project, or Profile when projectId is null. */
export interface MemoryPlacement {
    projectId?: string | null
    kind: MemoryKind
}

export interface CustomerMemory {
    memoryId: string
    text: string
    kind: MemoryKind
    category?: string | null
    sourceType: MemorySourceType
    sourceId?: string | null
    createdAt: string
    updatedAt: string
    placements: MemoryPlacement[]
    version: number
    /** False for memories stored before versions were recorded. */
    tracked: boolean
    hitCount: number
    lastUsedAt?: string | null
}

export type MemoryChangeType =
    | 'LEARNED'
    | 'UPDATED'
    | 'ADDED_BY_YOU'
    | 'EDITED_BY_YOU'
    | 'MOVED'
    | 'COPIED'
    | 'REMOVED_FROM_PROJECT'
    | 'LEGACY'

export interface MemoryChange {
    changeId: string
    type: MemoryChangeType
    createdAt: string
    version?: number | null
    text?: string | null
    previousText?: string | null
    sourceType?: MemorySourceType | null
    conversationId?: string | null
    messageId?: string | null
    noteKey?: string | null
    reason?: string | null
    /** The extraction run behind this change, for "How it was inferred". */
    runId?: string | null
    from?: MemoryPlacement[] | null
    to?: MemoryPlacement[] | null
    conversationTitle?: string | null
    conversationAvailable?: boolean | null
    youSaid?: string | null
}

export interface MemoryUsage {
    conversationId: string
    messageId: string
    usedAt: string
    how: 'core' | 'recalled' | 'search' | string
    conversationTitle?: string | null
    conversationAvailable: boolean
}

export interface GetMemoriesResponse {
    memories: CustomerMemory[]
}

export interface MemoryResponse {
    memory: CustomerMemory
}

export interface MemoryDetailResponse {
    memory: CustomerMemory
    versions: MemoryChange[]
    changes: MemoryChange[]
}

export interface MemoryUsagePage {
    items: MemoryUsage[]
    nextCursor?: string | null
    total: number
}

/**
 * A Memory page list: Profile Core, Profile Episodic, or one project. In the
 * URL it is `?scope=core|episodic|<projectId>`.
 */
export type MemoryScope =
    | { type: 'profile'; kind: MemoryKind }
    | { type: 'project'; projectId: string }

export const PROFILE_CORE: MemoryScope = { type: 'profile', kind: 'CORE' }

export function scopeFromParam(param: string | null): MemoryScope {
    if (!param || param === 'core') return PROFILE_CORE
    if (param === 'episodic') return { type: 'profile', kind: 'EPISODIC' }
    return { type: 'project', projectId: param }
}

export function scopeToParam(scope: MemoryScope): string {
    if (scope.type === 'project') return scope.projectId
    return scope.kind === 'CORE' ? 'core' : 'episodic'
}

export function isProfileMemory(memory: CustomerMemory): boolean {
    return memory.placements.some(p => !p.projectId)
}

/** The memory's placement in [scope], or undefined when it doesn't appear there. */
export function placementIn(memory: CustomerMemory, scope: MemoryScope): MemoryPlacement | undefined {
    if (scope.type === 'project') return memory.placements.find(p => p.projectId === scope.projectId)
    return memory.placements.find(p => !p.projectId && p.kind === scope.kind)
}

/** The memories listed in [scope], newest first. */
export function memoriesIn(memories: CustomerMemory[], scope: MemoryScope): CustomerMemory[] {
    return memories
        .filter(memory => placementIn(memory, scope))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/** How many memories each list holds: keys 'core', 'episodic' and each project id. */
export function memoryCounts(memories: CustomerMemory[]): Record<string, number> {
    const counts: Record<string, number> = { core: 0, episodic: 0 }
    memories.forEach(memory => memory.placements.forEach(placement => {
        const key = placement.projectId ?? (placement.kind === 'CORE' ? 'core' : 'episodic')
        counts[key] = (counts[key] ?? 0) + 1
    }))
    return counts
}
