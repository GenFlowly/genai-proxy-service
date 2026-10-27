import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider } from '../context/ToastContext'
import { useServiceWorkerUpdate } from './useServiceWorkerUpdate'
import { SW_UPDATE_AVAILABLE_EVENT } from '../serviceWorkerRegistration'

function Probe(): React.ReactElement {
    useServiceWorkerUpdate()
    return <div />
}

describe('useServiceWorkerUpdate', () => {
    test('toasts when the service worker reports an update is available', () => {
        render(
            <ToastProvider>
                <Probe />
            </ToastProvider>
        )

        act(() => {
            window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT))
        })

        expect(screen.getByText('A new version of AI Proxy is available. Refresh to update.')).toBeInTheDocument()
    })

    test('stops listening after unmount', () => {
        const { unmount } = render(
            <ToastProvider>
                <Probe />
            </ToastProvider>
        )

        unmount()

        act(() => {
            window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT))
        })

        expect(screen.queryByText('A new version of AI Proxy is available. Refresh to update.')).not.toBeInTheDocument()
    })
})
