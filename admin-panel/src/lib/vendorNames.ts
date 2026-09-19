import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { getVendorAllowlist, GetVendorAllowlistResponse } from '../services/vendorAllowlistService'
import { catalogIdFor, fallbackVendorDisplayName } from '../constants/vendors'

let cache: GetVendorAllowlistResponse | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
const getSnapshot = () => cache

/**
 * Vendor display names from the backend provider catalog — the single
 * source of truth for vendor naming (retrieval-server /providers, surfaced
 * to the admin panel via the vendor-allowlist endpoint). Returns a lookup
 * accepting either a stored vendor id ("OPENAI", "groq") or a catalog id
 * ("openai"); until the catalog is available it falls back to a
 * title-cased id.
 */
export function useVendorDisplayNames(): (vendorId: string) => string {
    const { getAccessTokenSilently } = useAuth0()
    const catalog = useSyncExternalStore(subscribe, getSnapshot)

    useEffect(() => {
        if (cache || inFlight) return
        inFlight = (async () => {
            try {
                cache = await getVendorAllowlist(await getAccessTokenSilently())
                listeners.forEach((l) => l())
            } catch { /* keep fallback names; a later mount retries */ } finally {
                inFlight = null
            }
        })()
    }, [getAccessTokenSilently])

    return useCallback((vendorId: string) => {
        const catalogId = catalogIdFor(vendorId)
        return catalog?.vendors.find((v) => v.id === catalogId)?.displayName
            ?? fallbackVendorDisplayName(vendorId)
    }, [catalog])
}
