import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom'
import { AppMenuOverlay } from '../../../../components/sections/L1Menu/AppMenuOverlay'
import { useAuth } from '../../../../context/AuthContext'
import { useLayout } from '../../../../context/LayoutContext'
import { useResponsiveBreakpoints } from '../../../../hooks/useResponsiveBreakpoints'

jest.mock('../../../../context/AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('../../../../context/LayoutContext', () => ({ useLayout: jest.fn() }))
jest.mock('../../../../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: jest.fn() }))
jest.mock('../../../../components/sections/L1Menu/L1Menu', () => ({ L1Menu: () => <div data-testid="l1-menu" /> }))

const mockSetLeftSidebarExpanded = jest.fn()

const LocationProbe = () => {
    const location = useLocation()
    return <div data-testid="location">{location.pathname} {JSON.stringify(location.state)}</div>
}

/** Collapses the sidebar on mount, as the real pages do. */
const CollapsingPage = () => {
    const { setLeftSidebarExpanded } = useLayout()
    React.useEffect(() => { setLeftSidebarExpanded(false) }, [setLeftSidebarExpanded])
    return <div data-testid="page" />
}

function renderAt(pathname: string, state: object) {
    return render(
        <MemoryRouter initialEntries={[{ pathname, state }]}>
            <Routes>
                <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
                <Route path="*" element={<CollapsingPage />} />
            </Routes>
            <AppMenuOverlay />
            <LocationProbe />
        </MemoryRouter>
    )
}

describe('AppMenuOverlay', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        ;(useAuth as jest.Mock).mockReturnValue({ isOnboarding: false })
        ;(useLayout as jest.Mock).mockReturnValue({ setLeftSidebarExpanded: mockSetLeftSidebarExpanded })
        ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: true })
    })

    test('opens the L2 Menu after the page has collapsed the sidebar on mount', () => {
        renderAt('/memory', { openMobileMenu: true })

        expect(mockSetLeftSidebarExpanded.mock.calls).toEqual([[false], [true]])
    })

    test('clears the request from history once it is acted on', async () => {
        renderAt('/memory', { openMobileMenu: true })

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memory null'))
    })

    test('does not undo a redirect the target page fires on arrival', async () => {
        renderAt('/settings', { openMobileMenu: true })

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/profile'))
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(screen.getByTestId('location')).toHaveTextContent('/settings/profile')
        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true)
    })

    test('keeps the request in history while /onboard is in flight', async () => {
        ;(useAuth as jest.Mock).mockReturnValue({ isOnboarding: true })
        renderAt('/chat', { openMobileMenu: true })

        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(screen.getByTestId('location')).toHaveTextContent('{"openMobileMenu":true}')
    })

    test('shows the L1 Menu only for the appMenu state and only below isNarrow', () => {
        const { unmount } = renderAt('/memory', { appMenu: true })
        expect(screen.getByTestId('l1-menu')).toBeInTheDocument()
        unmount()

        ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: false })
        renderAt('/memory', { appMenu: true })
        expect(screen.queryByTestId('l1-menu')).not.toBeInTheDocument()
    })
})
