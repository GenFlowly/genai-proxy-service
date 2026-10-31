import { useCallback } from 'react'
import { useProviderCatalog } from './queries/useProviderCatalog'
import { catalogIdFor, fallbackVendorDisplayName } from '../constants/vendors'

/**
 * Vendor display names from the backend provider catalog — the single
 * source of truth for vendor naming (retrieval-server /providers, see
 * _DISPLAY_NAMES there). Returns a lookup accepting either a stored vendor
 * id ("OPENAI", "groq") or a catalog id ("openai"); until the catalog is
 * available it falls back to a title-cased id.
 */
export function useVendorDisplayNames(): (vendorId: string) => string {
    const { data: catalog } = useProviderCatalog()

    return useCallback((vendorId: string) => {
        const catalogId = catalogIdFor(vendorId)
        return catalog?.providers.find(p => p.id === catalogId)?.displayName
            ?? fallbackVendorDisplayName(vendorId)
    }, [catalog])
}
