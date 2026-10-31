import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { getTextGenerationModels } from '../../services/getTextGenerationModelsService'
import { AIVendorModelList } from '../../models/getTextGenerationModels.models'
import { customerKey, StorageSuffix } from '../../utils/storageKeys'
import { TEXT_GEN_MODELS_QUERY_KEY } from './queryKeys'

export { TEXT_GEN_MODELS_QUERY_KEY }

function readModelsSeed(customerId: string | null): AIVendorModelList[] | undefined {
    if (!customerId) return undefined
    try {
        const raw = localStorage.getItem(customerKey(customerId, StorageSuffix.aiVendorModels))
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed) && parsed.length > 0) return parsed
        }
    } catch { /* corrupt cache — treat as empty */ }
    return undefined
}

/**
 * Available text-generation models per vendor (POST /api/v1/models), shared
 * by AIVendorWidget, VendorModelSelect and AISettings — one query per
 * distinct vendor set instead of three private caches. The model lists live
 * on the vendors' side so no version counter can gate them: paint from the
 * last known copy, refetch on mount. Skipped entirely without a valid-key
 * vendor (the server could only answer with an empty list).
 */
export function useTextGenerationModels(vendors: string[]) {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()
    const sortedVendors = [...vendors].sort()

    const query = useQuery<AIVendorModelList[]>({
        queryKey: [TEXT_GEN_MODELS_QUERY_KEY, customerId, sortedVendors],
        queryFn: async () => {
            const token = await getAccessTokenSilently()
            const response = await getTextGenerationModels(token, customerId ?? '', { aiVendor: vendors })
            const data = response.aiVendorModelList || []
            if (customerId && data.length > 0) {
                try {
                    localStorage.setItem(customerKey(customerId, StorageSuffix.aiVendorModels), JSON.stringify(data))
                } catch { /* quota */ }
            }
            return data
        },
        placeholderData: () => readModelsSeed(customerId),
        enabled: isAuthenticated && !!customerId && vendors.length > 0,
    })
    // Stale-on-error: a failed refresh keeps the last known model lists
    return {
        ...query,
        data: query.data ?? readModelsSeed(customerId),
    }
}
