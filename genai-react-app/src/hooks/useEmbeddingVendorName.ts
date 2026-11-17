import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { EmbeddingVendor } from '../services/embeddingKeysService'
import { useVendorDisplayNames } from './useVendorDisplayNames'

/**
 * Display name for an embedding vendor id. Voyage AI is embedding-only, so
 * the chat provider catalog doesn't name it; everything else comes from that
 * catalog.
 */
export function useEmbeddingVendorName(): (vendor: string) => string {
    const { t } = useTranslation()
    const vendorDisplayName = useVendorDisplayNames()
    return useCallback((vendor: string) => (
        vendor.toUpperCase() === EmbeddingVendor.VOYAGE
            ? t('settingsPage.embeddingDefaults.voyageLabel')
            : vendorDisplayName(vendor)
    ), [t, vendorDisplayName])
}
