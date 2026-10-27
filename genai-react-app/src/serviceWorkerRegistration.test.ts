import { register, unregister } from './serviceWorkerRegistration'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_URL

function setServiceWorkerMock(overrides: Partial<ServiceWorkerContainer> = {}) {
    const serviceWorker = {
        register: jest.fn(),
        ready: Promise.resolve({ unregister: jest.fn() }),
        controller: null,
        ...overrides,
    }
    Object.defineProperty(navigator, 'serviceWorker', {
        value: serviceWorker,
        configurable: true,
    })
    return serviceWorker
}

async function flushPromises() {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('serviceWorkerRegistration', () => {
    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV
        process.env.PUBLIC_URL = ORIGINAL_PUBLIC_URL
        delete (navigator as any).serviceWorker
        jest.restoreAllMocks()
    })

    test('register() no-ops outside production', () => {
        process.env.NODE_ENV = 'test'
        const serviceWorker = setServiceWorkerMock()
        const addEventListenerSpy = jest.spyOn(window, 'addEventListener')

        register()

        expect(addEventListenerSpy).not.toHaveBeenCalledWith('load', expect.anything())
        expect(serviceWorker.register).not.toHaveBeenCalled()
    })

    test("register() no-ops when the browser doesn't support service workers", () => {
        process.env.NODE_ENV = 'production'
        delete (navigator as any).serviceWorker
        const addEventListenerSpy = jest.spyOn(window, 'addEventListener')

        register()

        expect(addEventListenerSpy).not.toHaveBeenCalledWith('load', expect.anything())
    })

    test('register() no-ops when PUBLIC_URL is cross-origin', () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = 'https://a-different-cdn.example.com'
        setServiceWorkerMock()
        const addEventListenerSpy = jest.spyOn(window, 'addEventListener')

        register()

        expect(addEventListenerSpy).not.toHaveBeenCalledWith('load', expect.anything())
    })

    test('registers and reports success when the SW script is valid (jsdom runs on localhost)', async () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = ''
        let onupdatefound: (() => void) | undefined
        const installingWorker: any = { state: 'installed', onstatechange: null as (() => void) | null }
        const registration: any = {
            installing: installingWorker,
            set onupdatefound(fn: () => void) {
                onupdatefound = fn
            },
        }
        const serviceWorker = setServiceWorkerMock({ register: jest.fn().mockResolvedValue(registration), controller: null })
        jest.spyOn(global, 'fetch').mockResolvedValue({
            status: 200,
            headers: { get: () => 'text/javascript' },
        } as any)
        const onSuccess = jest.fn()

        register({ onSuccess })
        window.dispatchEvent(new Event('load'))
        await flushPromises()
        await flushPromises()

        expect(global.fetch).toHaveBeenCalledWith('/service-worker.js', { headers: { 'Service-Worker': 'script' } })
        expect(serviceWorker.register).toHaveBeenCalledWith('/service-worker.js')

        onupdatefound?.()
        installingWorker.onstatechange?.()

        expect(onSuccess).toHaveBeenCalledWith(registration)
    })

    test('reports an update when a previous service worker already controls the page', async () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = ''
        let onupdatefound: (() => void) | undefined
        const installingWorker: any = { state: 'installed', onstatechange: null as (() => void) | null }
        const registration: any = {
            installing: installingWorker,
            set onupdatefound(fn: () => void) {
                onupdatefound = fn
            },
        }
        setServiceWorkerMock({ register: jest.fn().mockResolvedValue(registration), controller: {} as any })
        jest.spyOn(global, 'fetch').mockResolvedValue({
            status: 200,
            headers: { get: () => 'text/javascript' },
        } as any)
        const onUpdate = jest.fn()

        register({ onUpdate })
        window.dispatchEvent(new Event('load'))
        await flushPromises()
        await flushPromises()

        onupdatefound?.()
        installingWorker.onstatechange?.()

        expect(onUpdate).toHaveBeenCalledWith(registration)
    })

    test('unregisters a stale registration when the SW script 404s', async () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = ''
        const unregisterMock = jest.fn()
        setServiceWorkerMock({ ready: Promise.resolve({ unregister: unregisterMock } as any) })
        jest.spyOn(global, 'fetch').mockResolvedValue({ status: 404, headers: { get: () => null } } as any)

        register()
        window.dispatchEvent(new Event('load'))
        await flushPromises()
        await flushPromises()

        expect(unregisterMock).toHaveBeenCalled()
    })

    test('swallows a failed fetch (offline) without throwing', async () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = ''
        setServiceWorkerMock()
        jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'))
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

        register()
        window.dispatchEvent(new Event('load'))
        await flushPromises()

        expect(logSpy).toHaveBeenCalledWith('No internet connection found. App is running in offline mode.')
    })

    test('logs when navigator.serviceWorker.register() rejects', async () => {
        process.env.NODE_ENV = 'production'
        process.env.PUBLIC_URL = ''
        setServiceWorkerMock({ register: jest.fn().mockRejectedValue(new Error('boom')) })
        jest.spyOn(global, 'fetch').mockResolvedValue({
            status: 200,
            headers: { get: () => 'text/javascript' },
        } as any)
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

        register()
        window.dispatchEvent(new Event('load'))
        await flushPromises()
        await flushPromises()

        expect(errorSpy).toHaveBeenCalledWith('Service worker registration failed:', expect.any(Error))
    })

    test('unregister() unregisters the active registration', async () => {
        const unregisterMock = jest.fn()
        setServiceWorkerMock({ ready: Promise.resolve({ unregister: unregisterMock } as any) })

        unregister()
        await flushPromises()

        expect(unregisterMock).toHaveBeenCalled()
    })

    test('unregister() no-ops without service worker support', () => {
        delete (navigator as any).serviceWorker
        expect(() => unregister()).not.toThrow()
    })
})
