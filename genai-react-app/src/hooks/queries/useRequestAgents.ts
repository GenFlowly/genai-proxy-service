import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { getRequestAgents, GetCustomerRequestAgentsResponse } from '../../services/requestAgentsService'
import { requestAgentsCache } from '../../services/defaultsCacheService'
import { versionGatedQueryOptions } from './versionGatedQuery'
import { REQUEST_AGENTS_QUERY_KEY } from './queryKeys'

export { REQUEST_AGENTS_QUERY_KEY }

/**
 * The request-type → agent mapping (GET /api/v1/request-agents),
 * version-gated on the /onboard requestAgents counter — see useCustomerAgents
 * for the pattern.
 */
export function useRequestAgents() {
    const { isAuthenticated, isOnboarding, customerId, cacheVersions, getAccessTokenSilently } = useAuth()
    const version = cacheVersions?.requestAgents ?? null

    const query = useQuery<GetCustomerRequestAgentsResponse, Error, GetCustomerRequestAgentsResponse, readonly unknown[]>({
        ...versionGatedQueryOptions({
            queryKey: [REQUEST_AGENTS_QUERY_KEY, customerId] as const,
            customerId: customerId ?? '',
            version,
            cache: requestAgentsCache,
            fetcher: async () => getRequestAgents(await getAccessTokenSilently()),
        }),
        enabled: isAuthenticated && !!customerId && (cacheVersions !== null || !isOnboarding),
    })
    // Stale-on-error: a failed refresh keeps showing the last known mapping
    return {
        ...query,
        data: query.data ?? (customerId ? requestAgentsCache.getEnvelope(customerId)?.data : undefined),
    }
}
