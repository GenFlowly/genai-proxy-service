import { Envelope, SeededCache } from '../../services/defaultsCacheService'

/**
 * Query options for a per-customer resource gated by a server-side cache
 * version (the /onboard cacheVersions counters):
 *
 * - version matches the stored envelope → the envelope IS the data
 *   (initialData + staleTime Infinity): no network call at all.
 * - version differs / unknown → fetch once; the stale envelope paints as
 *   placeholder meanwhile; the fresh response is saved at the new version.
 * - Same-client mutations must queryClient.invalidateQueries the key prefix —
 *   version counters only refresh at the next /onboard sync.
 *
 * Callers add `enabled`; gate it on the /onboard sync having settled (version
 * known or confirmed absent) or a returning user pays a throwaway
 * null-version fetch the moment the real version arrives.
 */
export function versionGatedQueryOptions<T extends object>(args: {
    queryKey: readonly unknown[]
    customerId: string
    version: number | null
    cache: SeededCache<T>
    fetcher: () => Promise<T>
}) {
    const { queryKey, customerId, version, cache, fetcher } = args
    return {
        queryKey: [...queryKey, version] as const,
        queryFn: async () => {
            const data = await fetcher()
            cache.save(customerId, data, version)
            return data
        },
        staleTime: Infinity,
        initialData: (): T | undefined => {
            const envelope: Envelope<T> | null = cache.getEnvelope(customerId)
            if (envelope && version !== null && envelope.version === version) return envelope.data
            return undefined
        },
        placeholderData: (): T | undefined => cache.getEnvelope(customerId)?.data,
    }
}
