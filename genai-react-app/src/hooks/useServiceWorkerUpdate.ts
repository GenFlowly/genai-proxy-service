import { useEffect } from 'react'
import { useToast } from '../context/ToastContext'
import { SW_UPDATE_AVAILABLE_EVENT } from '../serviceWorkerRegistration'

/**
 * Toasts the user once the service worker registered in index.tsx reports a
 * new version is installed. Does NOT auto-activate the new worker (no
 * skipWaiting/reload) — an unannounced reload mid-chat is worse than asking
 * the user to refresh when convenient.
 */
export function useServiceWorkerUpdate() {
    const { showToast } = useToast()

    useEffect(() => {
        const handleUpdate = () => showToast('A new version of AI Proxy is available. Refresh to update.')
        window.addEventListener(SW_UPDATE_AVAILABLE_EVENT, handleUpdate)
        return () => window.removeEventListener(SW_UPDATE_AVAILABLE_EVENT, handleUpdate)
    }, [showToast])
}
