import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import {
    fetchProviderCatalog,
    getCachedProviderCatalog,
    ProviderCatalogResponse,
    saveProviderCatalog,
} from '../../services/providerCatalogService'
import { PROVIDER_CATALOG_QUERY_KEY } from './queryKeys'

export { PROVIDER_CATALOG_QUERY_KEY }

/**
 * BYOK provider catalog (GET /api/v1/providers). Static per backend deploy,
 * so one fetch per browser session (staleTime Infinity) shared by every
 * consumer; the previous session's copy paints as placeholder until it lands.
 */
export function useProviderCatalog() {
    const { isSessionAuthenticated, getAccessTokenSilently } = useAuth()

    return useQuery<ProviderCatalogResponse>({
        queryKey: [PROVIDER_CATALOG_QUERY_KEY],
        queryFn: async () => {
            const parsed = await fetchProviderCatalog(await getAccessTokenSilently())
            if (parsed.providers.length > 0) saveProviderCatalog(parsed)
            return parsed
        },
        staleTime: Infinity,
        gcTime: Infinity,
        placeholderData: () => getCachedProviderCatalog() ?? undefined,
        enabled: isSessionAuthenticated,
    })
}
