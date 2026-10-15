import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAI } from '../context/AIContext'
import { useAuth } from '../context/AuthContext'
import {
    getCachedProviderCatalog,
    getProviderCatalog,
    ProviderCatalogResponse,
    subscribeProviderCatalog,
} from '../services/providerCatalogService'
import { catalogIdFor } from '../constants/vendors'

/**
 * The selected models (vendor + model pairs of the AI config) that the
 * provider catalog marks `supportsPdfInput: false`: they don't read a PDF
 * natively and get only its extracted text. A model missing from the catalog,
 * or a catalog without the flag (older backends), counts as unknown and is
 * left out, so the composer never warns on a guess.
 */
export function modelsWithoutPdfInput(
    configs: { aiVendor: string; model: string }[],
    catalog: ProviderCatalogResponse | null
): string[] {
    if (!catalog) return []
    const names: string[] = []
    for (const { aiVendor, model } of configs) {
        if (!aiVendor || !model) continue
        const provider = catalog.providers.find(p => p.id === catalogIdFor(aiVendor))
        const entry = provider?.models.find(m => m.name === model)
        if (entry?.supportsPdfInput === false && !names.includes(model)) names.push(model)
    }
    return names
}

/**
 * modelsWithoutPdfInput for the user's current model selection, kept in step
 * with the provider catalog (fetched once per session, shared with the
 * vendor display names). Feeds the composer's "can't read PDFs directly" hint.
 */
export function useModelsWithoutPdfInput(): string[] {
    const { config } = useAI()
    const { isAuthenticated, getAccessTokenSilently } = useAuth()
    const catalog = useSyncExternalStore(subscribeProviderCatalog, getCachedProviderCatalog)

    useEffect(() => {
        if (!isAuthenticated) return
        void (async () => {
            try {
                await getProviderCatalog(await getAccessTokenSilently())
            } catch { /* no catalog, no hint */ }
        })()
    }, [isAuthenticated, getAccessTokenSilently])

    return useMemo(() => modelsWithoutPdfInput(config, catalog), [config, catalog])
}
