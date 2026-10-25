import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { prefetchDefaultsPageData } from '../services/defaultsCacheService'

/**
 * Fire-and-forget warm-up of the Settings → Defaults page caches as soon as
 * the session is authenticated, so the page renders populated on first visit
 * (the embedding-model catalog in particular can take seconds server-side).
 */
export function useDefaultsPrefetch(): void {
    const { isAuthenticated, customerId, getAccessTokenSilently } = useAuth()

    useEffect(() => {
        if (!isAuthenticated || !customerId) return
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                await prefetchDefaultsPageData(token, customerId)
            } catch { /* best-effort — the page loads normally without the warm-up */ }
        })()
    }, [isAuthenticated, customerId, getAccessTokenSilently])
}
