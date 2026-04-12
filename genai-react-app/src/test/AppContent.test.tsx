import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom'

// Mock all heavy providers and pages
jest.mock('../context/AuthContext', () => ({
    useAuth: jest.fn(),
    AuthProvider: ({ children }: any) => <>{children}</>,
}))
jest.mock('../context/AIContext', () => ({
    useAI: jest.fn(),
    AIProvider: ({ children }: any) => <>{children}</>,
}))
jest.mock('../context/ConversationContext', () => ({
    useConversation: jest.fn(),
    ConversationProvider: ({ children }: any) => <>{children}</>,
}))
jest.mock('../context/LayoutContext', () => ({
    useLayout: jest.fn(),
    LayoutProvider: ({ children }: any) => <>{children}</>,
}))
jest.mock('../context/ToastContext', () => ({
    useToast: jest.fn(),
    ToastProvider: ({ children }: any) => <>{children}</>,
}))

jest.mock('../pages/LandingPage', () => () => <div data-testid="landing-page" />)
jest.mock('../pages/SettingsPage/SettingsPage', () => () => <div data-testid="settings-page" />)
jest.mock('../pages/MemoryPage/MemoryPage', () => () => <div data-testid="memory-page" />)

const mockLoginWithRedirect = jest.fn()
jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn(() => ({
        isAuthenticated: false,
        isLoading: false,
        loginWithRedirect: mockLoginWithRedirect,
    })),
}))

import { useAuth } from '../context/AuthContext'
import { useAuth0 } from '@auth0/auth0-react'
import AppContent from '../AppContent'

const mockUseAuth = useAuth as jest.Mock
const mockUseAuth0 = useAuth0 as jest.Mock

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <AppContent />
        </MemoryRouter>
    )
}

describe('AppContent', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockUseAuth.mockReturnValue({ isLoading: false })
        mockUseAuth0.mockReturnValue({
            isAuthenticated: false,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        })
    })

    test('shows loading indicator while auth is loading', () => {
        mockUseAuth.mockReturnValue({ isLoading: true })
        render(
            <MemoryRouter>
                <AppContent />
            </MemoryRouter>
        )
        expect(screen.getByText('Loading...')).toBeInTheDocument()
    })

    test('/ redirects to /chat', () => {
        renderAt('/')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    test('/chat renders LandingPage', () => {
        renderAt('/chat')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    test('/settings redirects to login when unauthenticated', async () => {
        renderAt('/settings')
        // ProtectedRoute calls loginWithRedirect for unauthenticated users
        await screen.findByText('Loading...').catch(() => {})
        expect(mockLoginWithRedirect).toHaveBeenCalledWith({
            appState: { returnTo: expect.any(String) }
        })
        expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument()
    })

    test('/memory redirects to login when unauthenticated', async () => {
        renderAt('/memory')
        await screen.findByText('Loading...').catch(() => {})
        expect(mockLoginWithRedirect).toHaveBeenCalledWith({
            appState: { returnTo: expect.any(String) }
        })
        expect(screen.queryByTestId('memory-page')).not.toBeInTheDocument()
    })

    test('/settings renders SettingsPage when authenticated', () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        })
        renderAt('/settings')
        expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    })

    test('/memory renders MemoryPage when authenticated', () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        })
        renderAt('/memory')
        expect(screen.getByTestId('memory-page')).toBeInTheDocument()
    })

    test('/chat/:conversationId redirects to login when unauthenticated', async () => {
        renderAt('/chat/some-id')
        await screen.findByText('Loading...').catch(() => {})
        expect(mockLoginWithRedirect).toHaveBeenCalledWith({
            appState: { returnTo: expect.any(String) }
        })
    })

    test('/chat/:conversationId renders LandingPage when authenticated', () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        })
        renderAt('/chat/some-id')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })
})
