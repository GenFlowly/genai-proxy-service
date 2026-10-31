import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { getEmbeddingModels, GetEmbeddingModelsResponse } from '../../services/embeddingKeysService'
import { embeddingModelsCache } from '../../services/defaultsCacheService'
import { EMBEDDING_MODELS_QUERY_KEY } from './queryKeys'

export { EMBEDDING_MODELS_QUERY_KEY }

/**
 * Probed embedding-model catalog (GET /api/v1/embedding-models). Settings →
 * Defaults only — deliberately NOT part of any login warm-up (it costs
 * per-vendor key reads + KMS decrypts server-side). No version counter exists
 * for it, so this stays paint-from-cache-then-always-refetch; the server's
 * own probe cache keeps the refetch cheap.
 */
export function useEmbeddingModels() {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()

    const query = useQuery<GetEmbeddingModelsResponse>({
        queryKey: [EMBEDDING_MODELS_QUERY_KEY, customerId],
        queryFn: async () => {
            const data = await getEmbeddingModels(await getAccessTokenSilently())
            embeddingModelsCache.save(customerId ?? '', data, null)
            return data
        },
        placeholderData: () => embeddingModelsCache.getEnvelope(customerId ?? '')?.data,
        refetchOnMount: 'always',
        enabled: isAuthenticated && !!customerId,
    })
    // Stale-on-error: a failed probe refresh keeps showing the last known list
    return {
        ...query,
        data: query.data ?? (customerId ? embeddingModelsCache.getEnvelope(customerId)?.data : undefined),
    }
}
