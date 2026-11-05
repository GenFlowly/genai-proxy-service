import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import '@testing-library/jest-dom'
import { L1Menu } from '../../../../components/sections/L1Menu/L1Menu'
import { useAuth } from '../../../../context/AuthContext'
import { useConversation } from '../../../../context/ConversationContext'
import { useLayout } from '../../../../context/LayoutContext'

jest.mock('../../../../context/AuthContext', () => ({ useAuth: jest.fn() }))
jest.mock('../../../../context/ConversationContext', () => ({ useConversation: jest.fn() }))
jest.mock('../../../../context/LayoutContext', () => ({ useLayout: jest.fn() }))
jest.mock('../../../../components/common/ThemeToggle/ThemeToggle', () => ({
    __esModule: true,
    default: ({ variant }: { variant?: string }) => <div data-testid="theme-toggle-mock">{variant}</div>,
}))

const mockLogin = jest.fn()
const mockSetLeftSidebarExpanded = jest.fn()

const signedOut = {
    isAuthenticated: false,
    isOnboarding: false,
    user: null,
    loginWithRedirect: mockLogin,
}

const signedIn = {
    ...signedOut,
    isAuthenticated: true,
    user: { sub: 'u', email: 'e', name: 'Auth Name' },
    customerName: 'Alex Morgan',
}

const LocationProbe = () => {
    const location = useLocation()
    return <div data-testid="location">{location.pathname} {JSON.stringify(location.state)}</div>
}

function renderMenu(entry: string | { pathname: string; state: object } = '/') {
    return render(
        <MemoryRouter initialEntries={[entry]}>
            <L1Menu />
            <LocationProbe />
        </MemoryRouter>
    )
}

describe('L1Menu', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        ;(useAuth as jest.Mock).mockReturnValue(signedOut)
        ;(useConversation as jest.Mock).mockReturnValue({ conversationId: null })
        ;(useLayout as jest.Mock).mockReturnValue({ setLeftSidebarExpanded: mockSetLeftSidebarExpanded })
    })

    describe('signed out', () => {
        test('is the landing page: brand, headline, login and theme, with no navigation', () => {
            renderMenu()

            expect(screen.getByText('Unbiase AI')).toBeInTheDocument()
            const headline = screen.getByRole('heading', { level: 1 })
            expect(within(headline).getByText('One prompt.')).toBeInTheDocument()
            expect(within(headline).getByText('Many models.')).toBeInTheDocument()
            expect(within(headline).getByText('Evaluate all.')).toBeInTheDocument()
            expect(screen.getByTestId('l1-menu-login')).toBeInTheDocument()
            expect(screen.getByTestId('theme-toggle-mock')).toHaveTextContent('surface')
            expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
        })

        test('login returns to the Chat L2 Menu', () => {
            renderMenu()

            fireEvent.click(screen.getByTestId('l1-menu-login'))

            expect(mockLogin).toHaveBeenCalledWith({
                appState: { returnTo: '/chat', returnState: { openMobileMenu: true } },
            })
        })

        test('shows a placeholder instead of Login while /onboard is in flight', () => {
            ;(useAuth as jest.Mock).mockReturnValue({ ...signedOut, isOnboarding: true })
            renderMenu()

            expect(screen.getByTestId('l1-menu-auth-placeholder')).toBeInTheDocument()
            expect(screen.queryByTestId('l1-menu-login')).not.toBeInTheDocument()
        })
    })

    describe('signed in', () => {
        beforeEach(() => {
            ;(useAuth as jest.Mock).mockReturnValue(signedIn)
        })

        test('lists the destinations, the account and the theme; no back or close', () => {
            renderMenu()

            for (const id of ['chat', 'memory', 'agents', 'instructions']) {
                expect(screen.getByTestId(`l1-menu-item-${id}`)).toBeInTheDocument()
            }
            expect(screen.getByText('Alex Morgan')).toBeInTheDocument()
            expect(screen.getByTestId('theme-toggle-mock')).toBeInTheDocument()
            expect(screen.queryByTestId('l1-menu-login')).not.toBeInTheDocument()
            expect(screen.queryByTestId('mobile-menu-back')).not.toBeInTheDocument()
            expect(screen.queryByTestId('mobile-menu-close')).not.toBeInTheDocument()
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        })

        test('falls back to a generic account label', () => {
            ;(useAuth as jest.Mock).mockReturnValue({
                ...signedIn,
                customerName: undefined,
                user: { sub: 'u', email: 'e', name: '' },
            })
            renderMenu()

            expect(screen.getByText('Account')).toBeInTheDocument()
        })

        test('shows the avatar picture when there is one', () => {
            ;(useAuth as jest.Mock).mockReturnValue({ ...signedIn, customerPicture: 'https://x/p.png' })
            const { container } = renderMenu()

            expect(container.querySelector('img[src="https://x/p.png"]')).toBeInTheDocument()
        })

        test.each(['chat', 'memory', 'agents'])('picking %s asks for its L2 Menu', (id) => {
            renderMenu()

            fireEvent.click(screen.getByTestId(`l1-menu-item-${id}`))

            expect(screen.getByTestId('location')).toHaveTextContent(`/${id} {"openMobileMenu":true}`)
            expect(mockSetLeftSidebarExpanded).not.toHaveBeenCalled()
        })

        test('picking Instructions goes straight to the screen and drops an open L2 Menu', () => {
            renderMenu()

            fireEvent.click(screen.getByTestId('l1-menu-item-instructions'))

            expect(screen.getByTestId('location')).toHaveTextContent('/instructions')
            expect(screen.getByTestId('location')).not.toHaveTextContent('openMobileMenu')
            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false)
        })

        test('picking Chat with a conversation open returns to it', () => {
            ;(useConversation as jest.Mock).mockReturnValue({ conversationId: 'abc' })
            renderMenu()

            fireEvent.click(screen.getByTestId('l1-menu-item-chat'))

            expect(screen.getByTestId('location')).toHaveTextContent('/chat/abc {"openMobileMenu":true}')
        })

        test('the account row asks for the Settings L2 Menu', () => {
            renderMenu()

            fireEvent.click(screen.getByTestId('l1-menu-account'))

            expect(screen.getByTestId('location')).toHaveTextContent('/settings {"openMobileMenu":true}')
        })

        test('the account row keeps the settings section you are on', () => {
            renderMenu({ pathname: '/settings/usage', state: { appMenu: true } })

            fireEvent.click(screen.getByTestId('l1-menu-account'))

            expect(screen.getByTestId('location')).toHaveTextContent('/settings/usage {"openMobileMenu":true}')
        })

        test('marks the page underneath as current', () => {
            renderMenu({ pathname: '/memory', state: { appMenu: true } })

            expect(screen.getByTestId('l1-menu-item-memory')).toHaveAttribute('aria-current', 'page')
            expect(screen.getByTestId('l1-menu-item-chat')).not.toHaveAttribute('aria-current')
        })

        test('as an overlay it is a dialog and picks replace its history entry', () => {
            render(
                <MemoryRouter initialEntries={['/memory', { pathname: '/memory', state: { appMenu: true } }]} initialIndex={1}>
                    <L1Menu />
                </MemoryRouter>
            )

            expect(screen.getByRole('dialog')).toBeInTheDocument()
            expect(screen.getByTestId('l1-menu-item-chat')).toHaveAttribute('href', '/chat')
        })
    })
})
