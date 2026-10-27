import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider } from '../../../../context/ToastContext'
import ServiceWorkerUpdateNotifier from '../../../../components/common/ServiceWorkerUpdateNotifier/ServiceWorkerUpdateNotifier'
import { SW_UPDATE_AVAILABLE_EVENT } from '../../../../serviceWorkerRegistration'

describe('ServiceWorkerUpdateNotifier', () => {
    test('renders nothing and surfaces a toast once an update is available', () => {
        const { container } = render(
            <ToastProvider>
                <ServiceWorkerUpdateNotifier />
            </ToastProvider>
        )

        expect(container.querySelector('[data-testid]')).toBeNull()

        act(() => {
            window.dispatchEvent(new CustomEvent(SW_UPDATE_AVAILABLE_EVENT))
        })

        expect(screen.getByText('A new version of AI Proxy is available. Refresh to update.')).toBeInTheDocument()
    })
})
