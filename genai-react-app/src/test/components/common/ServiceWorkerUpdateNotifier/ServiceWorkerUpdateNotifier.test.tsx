import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import ServiceWorkerUpdateNotifier from '../../../../components/common/ServiceWorkerUpdateNotifier/ServiceWorkerUpdateNotifier'
import { SW_UPDATE_AVAILABLE_EVENT } from '../../../../serviceWorkerRegistration'

function dispatchUpdate(waiting: ServiceWorker | null) {
    const registration = { waiting } as unknown as ServiceWorkerRegistration
    act(() => {
        window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT, { detail: registration }))
    })
}

describe('ServiceWorkerUpdateNotifier', () => {
    test('renders nothing until an update with a waiting worker is available', () => {
        const { container } = render(<ServiceWorkerUpdateNotifier />)
        expect(container.firstChild).toBeNull()
    })

    test('shows a refresh banner once a worker is waiting, and posts SKIP_WAITING on click', () => {
        const postMessage = jest.fn()
        render(<ServiceWorkerUpdateNotifier />)

        dispatchUpdate({ postMessage } as unknown as ServiceWorker)

        expect(screen.getByText('A new version of AI Proxy is available.')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('sw-update-refresh'))

        expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    })
})
