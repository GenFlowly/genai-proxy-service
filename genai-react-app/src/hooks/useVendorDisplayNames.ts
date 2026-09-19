import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../context/AuthContext'
import {
    getCachedProviderCatalog,
    getProviderCatalog,
    subscribeProviderCatalog,
} from '../services/providerCatalogService'
import { catalogIdFor, fallbackVendorDisplayName } from '../constants/vendors'

/**
 * Vendor display names from the backend provider catalog — the single
 * source of truth for vendor naming (retrieval-server /providers, see
 * _DISPLAY_NAMES there). Returns a lookup accepting either a stored vendor
 * id ("OPENAI", "groq") or a catalog id ("openai"); until the catalog is
 * available it falls back to a title-cased id.
 */
export function useVendorDisplayNames(): (vendorId: string) => string {
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const catalog = useSyncExternalStore(subscribeProviderCatalog, getCachedProviderCatalog)

    useEffect(() => {
        if (!isAuthenticated) return
        void (async () => {
            try {
                await getProviderCatalog(await getAccessTokenSilently())
            } catch { /* keep fallback names; a later consumer retries */ }
        })()
    }, [isAuthenticated, getAccessTokenSilently])

    return useCallback((vendorId: string) => {
        const catalogId = catalogIdFor(vendorId)
        return catalog?.providers.find(p => p.id === catalogId)?.displayName
            ?? fallbackVendorDisplayName(vendorId)
    }, [catalog])
}
