import { useServiceWorkerUpdate } from '../../../hooks/useServiceWorkerUpdate'

/** Renders nothing; must sit inside ToastProvider so the update toast has somewhere to go. */
export default function ServiceWorkerUpdateNotifier(): null {
    useServiceWorkerUpdate()
    return null
}
