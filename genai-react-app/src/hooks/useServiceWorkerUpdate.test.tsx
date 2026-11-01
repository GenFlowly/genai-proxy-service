import React from 'react'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import { useServiceWorkerUpdate } from './useServiceWorkerUpdate'
import { SW_UPDATE_AVAILABLE_EVENT } from '../serviceWorkerRegistration'

function Probe(): React.ReactElement {
    const { updateAvailable, applyUpdate } = useServiceWorkerUpdate()
    return (
        <div>
            <span>{updateAvailable ? 'available' : 'none'}</span>
            <button onClick={applyUpdate}>apply</button>
        </div>
    )
}

function dispatchUpdate(waiting: ServiceWorker | null) {
    const registration = { waiting } as unknown as ServiceWorkerRegistration
    act(() => {
        window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT, { detail: registration }))
    })
}

describe('useServiceWorkerUpdate', () => {
    test('reports no update by default', () => {
        render(<Probe />)
        expect(screen.getByText('none')).toBeInTheDocument()
    })

    test('reports an update once the registration has a waiting worker', () => {
        render(<Probe />)
        dispatchUpdate({} as ServiceWorker)
        expect(screen.getByText('available')).toBeInTheDocument()
    })

    test('does not report an update when the registration has no waiting worker', () => {
        render(<Probe />)
        dispatchUpdate(null)
        expect(screen.getByText('none')).toBeInTheDocument()
    })

    test('applyUpdate posts SKIP_WAITING to the waiting worker', () => {
        const postMessage = jest.fn()
        render(<Probe />)

        dispatchUpdate({ postMessage } as unknown as ServiceWorker)
        fireEvent.click(screen.getByText('apply'))

        expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    })

    test('stops listening after unmount', () => {
        const { unmount } = render(<Probe />)
        unmount()
        dispatchUpdate({} as ServiceWorker)
        expect(screen.queryByText('available')).not.toBeInTheDocument()
    })

    test('reloads once the new worker takes control', () => {
        const reload = jest.fn()
        Object.defineProperty(window, 'location', { value: { reload }, writable: true })

        const serviceWorker = new EventTarget() as unknown as ServiceWorkerContainer
        Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true })

        render(<Probe />)
        dispatchUpdate({} as ServiceWorker)

        act(() => {
            serviceWorker.dispatchEvent(new Event('controllerchange'))
        })

        expect(reload).toHaveBeenCalled()

        // Unmount while the mock serviceWorker is still in place, so the
        // effect's cleanup (removeEventListener) has something to call.
        cleanup()
        delete (navigator as any).serviceWorker
    })
})
