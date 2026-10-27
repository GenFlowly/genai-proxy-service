/// <reference lib="webworker" />
/// <reference types="react-scripts" />

import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)

// This app streams NDJSON chat responses (generate-text-stream, run
// reattach/resume) over a manual fetch()+ReadableStream, not EventSource —
// nothing under /api/ may ever be served from cache or buffered by the SW.
registerRoute(
    ({ url }) => url.pathname.startsWith('/api/'),
    new NetworkOnly()
)

const fileExtensionRegexp = /\/[^/?]+\.[^/]+$/

// SPA navigation fallback: serve the precached app shell for any in-scope
// navigation (client-side routed pages, the Auth0 redirect back to "/", a
// hard refresh on /chat/:id) so the app still boots when the network is
// slow or briefly unavailable. Auth0's code/state exchange happens client
// side after the shell loads, so serving it from cache doesn't affect login.
registerRoute(({ request, url }) => {
    if (request.mode !== 'navigate') return false
    if (url.pathname.startsWith('/api/')) return false
    if (fileExtensionRegexp.test(url.pathname)) return false
    return true
}, createHandlerBoundToURL(process.env.PUBLIC_URL + '/index.html'))

// Icons/screenshots don't need to be precache-pinned; keep them fresh with
// a background revalidate instead of baking them into the precache manifest.
registerRoute(
    ({ url }) => url.origin === self.location.origin && url.pathname.endsWith('.png'),
    new StaleWhileRevalidate({
        cacheName: 'images',
        plugins: [new ExpirationPlugin({ maxEntries: 50 })],
    })
)

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting()
    }
})
