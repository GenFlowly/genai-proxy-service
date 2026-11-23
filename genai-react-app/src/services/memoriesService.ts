import type { MemoryInferenceData } from '@genflowly/component-library'
import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { queryClient } from '../queryClient'
import { createCustomerCache } from '../utils/customerListCache'
import { StorageSuffix } from '../utils/storageKeys'
import { MEMORIES_QUERY_KEY, MEMORY_DETAIL_QUERY_KEY, MEMORY_USAGE_QUERY_KEY } from '../hooks/queries/queryKeys'
import {
    CustomerMemory,
    GetMemoriesResponse,
    MemoryDetailResponse,
    MemoryKind,
    MemoryResponse,
    MemoryUsagePage,
} from '../models/memory.models'

/** Last known memory list per customer, painted while the list refetches. */
export const memoriesCache = createCustomerCache<CustomerMemory[]>(
    StorageSuffix.memories,
    parsed => (Array.isArray(parsed) ? (parsed as CustomerMemory[]) : null)
)

/** A memory request the server refused; [status] 404 = gone, 409 = changed meanwhile. */
export class MemoryApiError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message)
        this.name = 'MemoryApiError'
    }
}

async function request<T>(token: string, url: string, method: HttpMethod, body?: unknown): Promise<T> {
    const response = await fetchWithRetry(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`
        try {
            const data = await response.json()
            if (typeof data?.error === 'string') message = data.error
        } catch {
            // No JSON body: keep the status line
        }
        throw new MemoryApiError(response.status, message)
    }
    return (await response.json()) as T
}

function activeCustomerId(): string | null {
    try {
        return localStorage.getItem('customerId')
    } catch {
        return null
    }
}

// Every mutation writes its result into the list query and the stored copy
// here, so no call site can forget; the detail and usage queries of a
// changed memory are refetched, since its versions and change log moved on.
function updateList(change: (list: CustomerMemory[]) => CustomerMemory[]): void {
    queryClient.setQueriesData<CustomerMemory[]>(
        { queryKey: [MEMORIES_QUERY_KEY] },
        (old: CustomerMemory[] | undefined) => (old ? change(old) : old)
    )
    const customerId = activeCustomerId()
    const stored = memoriesCache.load(customerId)
    if (customerId && stored) memoriesCache.save(customerId, change(stored))
}

function applyMemory(memory: CustomerMemory): void {
    updateList(list => [memory, ...list.filter(m => m.memoryId !== memory.memoryId)])
    queryClient.invalidateQueries({ queryKey: [MEMORY_DETAIL_QUERY_KEY, memory.memoryId] })
}

function forgetMemory(memoryId: string): void {
    updateList(list => list.filter(m => m.memoryId !== memoryId))
    queryClient.removeQueries({ queryKey: [MEMORY_DETAIL_QUERY_KEY, memoryId] })
    queryClient.removeQueries({ queryKey: [MEMORY_USAGE_QUERY_KEY, memoryId] })
}

export async function getMemories(token: string): Promise<CustomerMemory[]> {
    const data = await request<GetMemoriesResponse>(token, endpoints.memories, HttpMethod.GET)
    return Array.isArray(data.memories) ? data.memories : []
}

export async function getMemoryDetail(token: string, memoryId: string): Promise<MemoryDetailResponse> {
    return request<MemoryDetailResponse>(token, endpoints.memory(memoryId), HttpMethod.GET)
}

/** How run [runId] inferred the memory: the story and facts of one extraction run. */
export async function getMemoryInference(token: string, memoryId: string, runId: string): Promise<MemoryInferenceData> {
    return request<MemoryInferenceData>(token, endpoints.memoryInference(memoryId, runId), HttpMethod.GET)
}

export async function getMemoryUsage(
    token: string,
    memoryId: string,
    cursor?: string,
    limit = 25
): Promise<MemoryUsagePage> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    return request<MemoryUsagePage>(token, `${endpoints.memoryUsage(memoryId)}?${params}`, HttpMethod.GET)
}

/** Adds a memory the user wrote; [projectId] null puts it in Profile. */
export async function createMemory(
    token: string,
    text: string,
    kind: MemoryKind,
    projectId: string | null
): Promise<CustomerMemory> {
    const { memory } = await request<MemoryResponse>(token, endpoints.memories, HttpMethod.POST, { text, kind, projectId })
    applyMemory(memory)
    return memory
}

/** Saves [text] as a new version; refused with 409 when a newer version than [baseVersion] exists. */
export async function editMemory(
    token: string,
    memoryId: string,
    text: string,
    baseVersion: number
): Promise<CustomerMemory> {
    const { memory } = await request<MemoryResponse>(token, endpoints.memory(memoryId), HttpMethod.PUT, { text, baseVersion })
    applyMemory(memory)
    return memory
}

/** Changes where the memory applies. Null project ids mean Profile. */
export async function moveMemory(
    token: string,
    memoryId: string,
    fromProjectId: string | null,
    toProjectId: string | null,
    kind: MemoryKind
): Promise<CustomerMemory> {
    const { memory } = await request<MemoryResponse>(
        token, endpoints.moveMemory(memoryId), HttpMethod.POST, { fromProjectId, toProjectId, kind }
    )
    applyMemory(memory)
    return memory
}

/** Adds another project to a project memory; both share the one memory. */
export async function copyMemory(
    token: string,
    memoryId: string,
    fromProjectId: string,
    toProjectId: string,
    kind: MemoryKind
): Promise<CustomerMemory> {
    const { memory } = await request<MemoryResponse>(
        token, endpoints.copyMemory(memoryId), HttpMethod.POST, { fromProjectId, toProjectId, kind }
    )
    applyMemory(memory)
    return memory
}

/**
 * Deletes the memory everywhere, or with [projectId] on a memory several
 * projects share, removes it from that project only. Resolves to true when
 * the memory is gone. A memory that was already gone counts as deleted.
 */
export async function deleteMemory(token: string, memoryId: string, projectId?: string): Promise<boolean> {
    const url = projectId
        ? `${endpoints.memory(memoryId)}?projectId=${encodeURIComponent(projectId)}`
        : endpoints.memory(memoryId)
    let deleted = true
    try {
        deleted = (await request<{ deleted?: boolean }>(token, url, HttpMethod.DELETE)).deleted !== false
    } catch (error) {
        if (!(error instanceof MemoryApiError && error.status === 404)) throw error
    }
    if (deleted) {
        forgetMemory(memoryId)
    } else {
        updateList(list => list.map(m => m.memoryId === memoryId
            ? { ...m, placements: m.placements.filter(p => p.projectId !== projectId) }
            : m))
        queryClient.invalidateQueries({ queryKey: [MEMORY_DETAIL_QUERY_KEY, memoryId] })
    }
    return deleted
}

/** Deletes every memory with its logs. Resolves to how many were deleted. */
export async function deleteAllMemories(token: string): Promise<number> {
    const data = await request<{ deleted?: number }>(token, endpoints.memories, HttpMethod.DELETE)
    updateList(() => [])
    queryClient.removeQueries({ queryKey: [MEMORY_DETAIL_QUERY_KEY] })
    queryClient.removeQueries({ queryKey: [MEMORY_USAGE_QUERY_KEY] })
    return typeof data.deleted === 'number' ? data.deleted : 0
}
