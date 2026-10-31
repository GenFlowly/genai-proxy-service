import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { getCustomerAgents } from '../../services/agentsService'
import { GetCustomerAgentsResponse } from '../../models/agents.models'
import { customerAgentsCache } from '../../services/defaultsCacheService'
import { versionGatedQueryOptions } from './versionGatedQuery'
import { CUSTOMER_AGENTS_QUERY_KEY } from './queryKeys'

export { CUSTOMER_AGENTS_QUERY_KEY }

/**
 * The customer's agents (GET /api/v1/agents), version-gated: served straight
 * from the localStorage envelope when the /onboard agents counter is
 * unchanged, fetched once otherwise. All consumers (AgentPickerWidget, the
 * Defaults-page warm-up, Settings) share one query — one request per login
 * at most.
 */
export function useCustomerAgents() {
    const { isAuthenticated, isOnboarding, customerId, cacheVersions, getAccessTokenSilently } = useAuth()
    const version = cacheVersions?.agents ?? null

    const query = useQuery<GetCustomerAgentsResponse, Error, GetCustomerAgentsResponse, readonly unknown[]>({
        ...versionGatedQueryOptions({
            queryKey: [CUSTOMER_AGENTS_QUERY_KEY, customerId] as const,
            customerId: customerId ?? '',
            version,
            cache: customerAgentsCache,
            fetcher: async () => getCustomerAgents(await getAccessTokenSilently()),
        }),
        // Wait out the /onboard sync: fetching before the version is known
        // costs a throwaway null-version request the moment it arrives.
        enabled: isAuthenticated && !!customerId && (cacheVersions !== null || !isOnboarding),
    })
    // Stale-on-error: a failed refresh keeps showing the last known list
    // (isError && !data remains the signal for "failed with nothing cached").
    return {
        ...query,
        data: query.data ?? (customerId ? customerAgentsCache.getEnvelope(customerId)?.data : undefined),
    }
}
