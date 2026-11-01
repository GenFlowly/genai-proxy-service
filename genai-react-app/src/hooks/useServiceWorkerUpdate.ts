import { useCallback, useEffect, useState } from 'react'
import { SW_UPDATE_AVAILABLE_EVENT, SwUpdateAvailableEvent } from '../serviceWorkerRegistration'

/**
 * Tracks the service worker registered in index.tsx and exposes a way to
 * actually complete a pending update: postMessage SKIP_WAITING to the
 * waiting worker, then reload once it takes control. Nothing happens until
 * `applyUpdate` is called — an unannounced reload mid-chat is worse than
 * asking the user to confirm first.
 */
export function useServiceWorkerUpdate() {
    const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

    useEffect(() => {
        const handleUpdate = (event: Event) => {
            setRegistration((event as SwUpdateAvailableEvent).detail ?? null)
        }
        window.addEventListener(SW_UPDATE_AVAILABLE_EVENT, handleUpdate)
        return () => window.removeEventListener(SW_UPDATE_AVAILABLE_EVENT, handleUpdate)
    }, [])

    useEffect(() => {
        if (!registration || !('serviceWorker' in navigator)) return

        const onControllerChange = () => window.location.reload()
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
        return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }, [registration])

    const applyUpdate = useCallback(() => {
        registration?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    }, [registration])

    return { updateAvailable: registration?.waiting != null, applyUpdate }
}
