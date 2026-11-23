import { MemoryScope, scopeToParam } from '../../models/memory.models'

export function memoryPath(memoryId: string, scope?: MemoryScope): string {
    const path = `/memory/${encodeURIComponent(memoryId)}`
    return scope ? `${path}?scope=${encodeURIComponent(scopeToParam(scope))}` : path
}

/** "How it was inferred": the run [runId] that learned or changed the memory. */
export function memoryInferencePath(memoryId: string, runId: string): string {
    return `/memory/${encodeURIComponent(memoryId)}/inference/${encodeURIComponent(runId)}`
}
