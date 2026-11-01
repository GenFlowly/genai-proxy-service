// Registration for src/service-worker.ts, adapted from the CRA PWA template
// (https://github.com/cra-template/pwa). Production-only: localhost dev
// deliberately skips registration so `npm start` never serves a stale
// cached shell while iterating.

const isLocalhost = Boolean(
    window.location.hostname === 'localhost' ||
        window.location.hostname === '[::1]' ||
        window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
)

type Config = {
    onSuccess?: (registration: ServiceWorkerRegistration) => void
    onUpdate?: (registration: ServiceWorkerRegistration) => void
}

/** Dispatched on `window` when a new service worker has finished installing and is waiting to activate. */
export const SW_UPDATE_AVAILABLE_EVENT = 'sw-update-available'

/** Event detail carries the registration so listeners can reach `registration.waiting`. */
export type SwUpdateAvailableEvent = CustomEvent<ServiceWorkerRegistration>

export function register(config?: Config) {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) {
        return
    }

    const publicUrl = new URL(process.env.PUBLIC_URL, window.location.href)
    if (publicUrl.origin !== window.location.origin) {
        // The service worker can't control a page served from a different origin
        // than PUBLIC_URL (e.g. a CDN).
        return
    }

    window.addEventListener('load', () => {
        const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`

        if (isLocalhost) {
            checkValidServiceWorker(swUrl, config)
        } else {
            registerValidSW(swUrl, config)
        }
    })
}

function registerValidSW(swUrl: string, config?: Config) {
    navigator.serviceWorker
        .register(swUrl)
        .then((registration) => {
            registration.onupdatefound = () => {
                const installingWorker = registration.installing
                if (installingWorker == null) return

                installingWorker.onstatechange = () => {
                    if (installingWorker.state === 'installed') {
                        if (navigator.serviceWorker.controller) {
                            // New content is cached but the previous service worker is
                            // still controlling open tabs — surface the update instead of
                            // swapping the shell out from under the user mid-session.
                            config?.onUpdate?.(registration)
                        } else {
                            config?.onSuccess?.(registration)
                        }
                    }
                }
            }
        })
        .catch((error) => {
            console.error('Service worker registration failed:', error)
        })
}

function checkValidServiceWorker(swUrl: string, config?: Config) {
    fetch(swUrl, { headers: { 'Service-Worker': 'script' } })
        .then((response) => {
            const contentType = response.headers.get('content-type')
            if (response.status === 404 || (contentType != null && contentType.indexOf('javascript') === -1)) {
                navigator.serviceWorker.ready.then((registration) => {
                    registration.unregister()
                })
            } else {
                registerValidSW(swUrl, config)
            }
        })
        .catch(() => {
            console.log('No internet connection found. App is running in offline mode.')
        })
}

export function unregister() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready
            .then((registration) => registration.unregister())
            .catch((error) => console.error(error.message))
    }
}
