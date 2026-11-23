import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import type { MemoryInferenceData } from '@genflowly/component-library'
import { getMemories, getMemoryDetail, getMemoryInference, getMemoryUsage, memoriesCache } from '../../services/memoriesService'
import { getProjects } from '../../services/conversationHistoryService'
import { loadHistoryCache } from '../../components/widgets/ConversationHistoryWidget/historyCache'
import { CustomerMemory, MemoryDetailResponse } from '../../models/memory.models'
import { Project } from '../../models/conversationHistory.models'
import { MEMORIES_QUERY_KEY, MEMORY_DETAIL_QUERY_KEY, MEMORY_INFERENCE_QUERY_KEY, MEMORY_USAGE_QUERY_KEY, PROJECTS_QUERY_KEY } from './queryKeys'

/**
 * Every memory the customer has. The last session's list paints at once and
 * a fresh fetch replaces it on every mount, since the assistant keeps
 * learning in the background; mutations in memoriesService write through.
 */
export function useMemories() {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()

    return useQuery<CustomerMemory[]>({
        queryKey: [MEMORIES_QUERY_KEY, customerId],
        queryFn: async () => {
            const memories = await getMemories(await getAccessTokenSilently())
            memoriesCache.save(customerId, memories)
            return memories
        },
        placeholderData: () => memoriesCache.load(customerId) ?? undefined,
        refetchOnMount: 'always',
        enabled: isAuthenticated && !!customerId,
    })
}

/** One memory with its versions and change log. */
export function useMemoryDetail(memoryId: string | undefined) {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    return useQuery<MemoryDetailResponse>({
        queryKey: [MEMORY_DETAIL_QUERY_KEY, memoryId],
        queryFn: async () => getMemoryDetail(await getAccessTokenSilently(), memoryId!),
        refetchOnMount: 'always',
        enabled: isAuthenticated && !!memoryId,
        retry: false,
    })
}

/** How one extraction run inferred the memory. A run never changes, so it is fetched once. */
export function useMemoryInference(memoryId: string | undefined, runId: string | undefined) {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    return useQuery<MemoryInferenceData>({
        queryKey: [MEMORY_INFERENCE_QUERY_KEY, memoryId, runId],
        queryFn: async () => getMemoryInference(await getAccessTokenSilently(), memoryId!, runId!),
        enabled: isAuthenticated && !!memoryId && !!runId,
        retry: false,
        staleTime: Infinity,
    })
}

/** The replies a memory was used in, a page at a time, newest first. */
export function useMemoryUsage(memoryId: string | undefined, enabled = true) {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()

    return useInfiniteQuery({
        queryKey: [MEMORY_USAGE_QUERY_KEY, memoryId],
        queryFn: async ({ pageParam }: { pageParam: string | undefined }) =>
            getMemoryUsage(await getAccessTokenSilently(), memoryId!, pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: last => last.nextCursor ?? undefined,
        enabled: enabled && isAuthenticated && !!memoryId,
    })
}

/**
 * The customer's projects, the same list Chat shows: the conversation
 * history's stored copy paints first, then the server's.
 */
export function useProjects() {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()

    return useQuery<Project[]>({
        queryKey: [PROJECTS_QUERY_KEY, customerId],
        queryFn: async () => (await getProjects(await getAccessTokenSilently())).projects ?? [],
        placeholderData: () => loadHistoryCache(customerId)?.projects,
        refetchOnMount: 'always',
        enabled: isAuthenticated && !!customerId,
    })
}
