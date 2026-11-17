import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
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
    useToast: jest.fn(() => ({ showToast: jest.fn() })),
    ToastProvider: ({ children }: any) => <>{children}</>,
}))
jest.mock('../components/common/ServiceWorkerUpdateNotifier/ServiceWorkerUpdateNotifier', () => () => null)
jest.mock('../hooks/useResponsiveBreakpoints', () => ({ useResponsiveBreakpoints: jest.fn() }))
jest.mock('../components/sections/L1Menu/L1Menu', () => ({ L1Menu: () => <div data-testid="l1-menu" /> }))

jest.mock('../pages/LandingPage', () => () => <div data-testid="landing-page" />)
jest.mock('../pages/SettingsPage/SettingsPage', () => () => <div data-testid="settings-page" />)
jest.mock('../pages/MemoryPage/MemoryPage', () => () => <div data-testid="memory-page" />)
jest.mock('../pages/PrivacyPolicyPage/PrivacyPolicyPage', () => () => <div data-testid="privacy-policy-page" />)
jest.mock('../components/AppFooter/AppFooter', () => () => <footer data-testid="app-footer" />)
jest.mock('../components/onboarding/OnboardingWizard', () => ({
    OnboardingWizard: ({ onDone }: any) => (
        <div data-testid="onboarding-wizard-mock">
            <button data-testid="onboarding-wizard-mock-done" onClick={() => onDone()} />
        </div>
    ),
}))

jest.mock('../components/onboarding/AiDataConsentScreen', () => ({
    AiDataConsentScreen: ({ onAgree, onDecline }: any) => (
        <div data-testid="ai-consent-mock">
            <button data-testid="ai-consent-mock-agree" onClick={() => onAgree()} />
            <button data-testid="ai-consent-mock-decline" onClick={() => onDecline()} />
        </div>
    ),
}))

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
import { useLayout } from '../context/LayoutContext'
import { useResponsiveBreakpoints } from '../hooks/useResponsiveBreakpoints'
import AppContent from '../AppContent'
import { withQueryClient } from './utils/queryWrapper'

const mockUseAuth = useAuth as jest.Mock
const mockUseAuth0 = useAuth0 as jest.Mock

const mockSetLeftSidebarExpanded = jest.fn()

const LocationProbe = () => {
    const location = useLocation()
    return <div data-testid="location">{location.pathname} {JSON.stringify(location.state)}</div>
}

function renderAt(path: string | { pathname: string; state: object }) {
    return render(withQueryClient(
        <MemoryRouter initialEntries={[path]}>
            <AppContent />
            <LocationProbe />
        </MemoryRouter>
    ))
}

describe('AppContent', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockUseAuth.mockReturnValue({ isLoading: false })
        ;(useLayout as jest.Mock).mockReturnValue({ setLeftSidebarExpanded: mockSetLeftSidebarExpanded })
        ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: false, isMobile: false })
        mockUseAuth0.mockReturnValue({
            isAuthenticated: false,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        })
    })

    test('renders nothing while auth is loading, leaving the boot splash in view', () => {
        mockUseAuth.mockReturnValue({ isLoading: true })
        const { container } = render(withQueryClient(
            <MemoryRouter>
                <AppContent />
            </MemoryRouter>
        ))
        expect(container).toBeEmptyDOMElement()
    })

    test('/ redirects to /chat', () => {
        renderAt('/')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    test('/chat renders LandingPage', () => {
        renderAt('/chat')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    test('/privacy-policy opens signed out, and desktop pages have the footer', () => {
        renderAt('/privacy-policy')
        expect(screen.getByTestId('privacy-policy-page')).toBeInTheDocument()
        expect(screen.getByTestId('app-footer')).toBeInTheDocument()
        expect(mockLoginWithRedirect).not.toHaveBeenCalled()
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

    test('/chat/:conversationId renders LandingPage when unauthenticated', () => {
        renderAt('/chat/some-id')
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
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

    test('shows the onboarding wizard instead of routes when onboardingCompleted is false', () => {
        mockUseAuth.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            isOnboarding: false,
            onboardingCompleted: false,
            completeOnboarding: jest.fn(),
        })
        renderAt('/chat')
        expect(screen.getByTestId('onboarding-wizard-mock')).toBeInTheDocument()
        expect(screen.queryByTestId('landing-page')).not.toBeInTheDocument()
    })

    test('does not show the onboarding wizard while the /onboard sync is still in flight', () => {
        mockUseAuth.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            isOnboarding: true,
            onboardingCompleted: false,
            completeOnboarding: jest.fn(),
        })
        renderAt('/chat')
        expect(screen.queryByTestId('onboarding-wizard-mock')).not.toBeInTheDocument()
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    test('does not show the onboarding wizard once onboarding is completed', () => {
        mockUseAuth.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            isOnboarding: false,
            onboardingCompleted: true,
            completeOnboarding: jest.fn(),
        })
        renderAt('/chat')
        expect(screen.queryByTestId('onboarding-wizard-mock')).not.toBeInTheDocument()
        expect(screen.getByTestId('landing-page')).toBeInTheDocument()
    })

    describe('AI data consent gate', () => {
        const signedIn = (overrides: object) => mockUseAuth.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            isSessionAuthenticated: true,
            isOnboarding: false,
            onboardingCompleted: true,
            aiDataConsentRequired: true,
            acceptAiDataConsent: jest.fn(),
            logout: jest.fn(),
            ...overrides,
        })

        it('covers the whole app until the customer agrees', () => {
            signedIn({})
            renderAt('/chat')
            expect(screen.getByTestId('ai-consent-mock')).toBeInTheDocument()
            expect(screen.queryByTestId('landing-page')).not.toBeInTheDocument()
        })

        it('comes before the setup wizard for a new account', () => {
            signedIn({ onboardingCompleted: false })
            renderAt('/chat')
            expect(screen.getByTestId('ai-consent-mock')).toBeInTheDocument()
            expect(screen.queryByTestId('onboarding-wizard-mock')).not.toBeInTheDocument()
        })

        it('waits for /onboard before asking', () => {
            signedIn({ isOnboarding: true })
            renderAt('/chat')
            expect(screen.queryByTestId('ai-consent-mock')).not.toBeInTheDocument()
        })

        it('is gone once the customer has agreed', () => {
            signedIn({ aiDataConsentRequired: false })
            renderAt('/chat')
            expect(screen.queryByTestId('ai-consent-mock')).not.toBeInTheDocument()
            expect(screen.getByTestId('landing-page')).toBeInTheDocument()
        })

        it('leaves the privacy policy readable, for both gates', () => {
            signedIn({ onboardingCompleted: false })
            renderAt('/privacy-policy')
            expect(screen.getByTestId('privacy-policy-page')).toBeInTheDocument()
            expect(screen.queryByTestId('ai-consent-mock')).not.toBeInTheDocument()
            expect(screen.queryByTestId('onboarding-wizard-mock')).not.toBeInTheDocument()
        })

        it('agrees through the auth context', () => {
            const acceptAiDataConsent = jest.fn()
            signedIn({ acceptAiDataConsent })
            renderAt('/chat')
            fireEvent.click(screen.getByTestId('ai-consent-mock-agree'))
            expect(acceptAiDataConsent).toHaveBeenCalledTimes(1)
        })

        it('declining signs out', () => {
            const logout = jest.fn()
            signedIn({ logout })
            renderAt('/chat')
            fireEvent.click(screen.getByTestId('ai-consent-mock-decline'))
            expect(logout).toHaveBeenCalledWith({ returnTo: window.location.origin })
        })
    })

    describe('below isNarrow', () => {
        beforeEach(() => {
            ;(useResponsiveBreakpoints as jest.Mock).mockReturnValue({ isNarrow: true, isMobile: true })
        })

        const signedIn = {
            isLoading: false,
            isAuthenticated: true,
            isSessionAuthenticated: true,
            isOnboarding: false,
            onboardingCompleted: true,
            completeOnboarding: jest.fn(),
        }

        test('/ is the L1 Menu, not a redirect to /chat', () => {
            renderAt('/')
            expect(screen.getByTestId('l1-menu')).toBeInTheDocument()
            expect(screen.queryByTestId('landing-page')).not.toBeInTheDocument()
        })

        test('phones have no footer; the policy is in the Settings menu instead', () => {
            renderAt('/privacy-policy')
            expect(screen.getByTestId('privacy-policy-page')).toBeInTheDocument()
            expect(screen.queryByTestId('app-footer')).not.toBeInTheDocument()
        })

        test('signed out on a bare /chat lands on the L1 Menu', () => {
            renderAt('/chat')
            expect(screen.getByTestId('l1-menu')).toBeInTheDocument()
            expect(screen.getByTestId('location')).toHaveTextContent('/')
        })

        test('signed out on a shared conversation link stays on it', () => {
            renderAt('/chat/some-id')
            expect(screen.getByTestId('landing-page')).toBeInTheDocument()
            expect(screen.queryByTestId('l1-menu')).not.toBeInTheDocument()
        })

        test('signed in on a bare /chat stays on it', () => {
            mockUseAuth.mockReturnValue(signedIn)
            renderAt('/chat')
            expect(screen.getByTestId('landing-page')).toBeInTheDocument()
        })

        test('the login session alone is enough to stay on /chat while /onboard is in flight', () => {
            mockUseAuth.mockReturnValue({ ...signedIn, isAuthenticated: false, isOnboarding: true })
            renderAt('/chat')
            expect(screen.getByTestId('landing-page')).toBeInTheDocument()
        })

        test('the appMenu state shows the L1 Menu over the page, which stays mounted', () => {
            mockUseAuth.mockReturnValue(signedIn)
            renderAt({ pathname: '/chat/some-id', state: { appMenu: true } })
            expect(screen.getByTestId('l1-menu')).toBeInTheDocument()
            expect(screen.getByTestId('landing-page')).toBeInTheDocument()
        })

        test('an L2 Menu request opens it and leaves history clean', async () => {
            mockUseAuth.mockReturnValue(signedIn)
            renderAt({ pathname: '/chat', state: { openMobileMenu: true } })

            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true)
            await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat null'))
        })

        test('an L2 Menu request waits out the /onboard sync, since the wizard may follow', () => {
            mockUseAuth.mockReturnValue({ ...signedIn, isOnboarding: true })
            renderAt({ pathname: '/chat', state: { openMobileMenu: true } })

            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true)
            expect(screen.getByTestId('location')).toHaveTextContent('{"openMobileMenu":true}')
        })

        test('an L2 Menu request survives the wizard', () => {
            mockUseAuth.mockReturnValue({ ...signedIn, onboardingCompleted: false })
            renderAt({ pathname: '/chat', state: { openMobileMenu: true } })

            expect(screen.getByTestId('onboarding-wizard-mock')).toBeInTheDocument()
            expect(screen.getByTestId('location')).toHaveTextContent('{"openMobileMenu":true}')
        })

        test('finishing the wizard lands on the Chat L2 Menu, wherever it started', async () => {
            const completeOnboarding = jest.fn().mockResolvedValue(undefined)
            mockUseAuth.mockReturnValue({ ...signedIn, onboardingCompleted: false, completeOnboarding })
            renderAt('/')

            fireEvent.click(screen.getByTestId('onboarding-wizard-mock-done'))

            await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat {"openMobileMenu":true}'))
            expect(completeOnboarding).toHaveBeenCalledTimes(1)
        })
    })

    test('finishing the wizard on desktop stays where it is', async () => {
        const completeOnboarding = jest.fn().mockResolvedValue(undefined)
        mockUseAuth.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            isOnboarding: false,
            onboardingCompleted: false,
            completeOnboarding,
        })
        renderAt('/memory')

        fireEvent.click(screen.getByTestId('onboarding-wizard-mock-done'))

        await waitFor(() => expect(completeOnboarding).toHaveBeenCalled())
        expect(screen.getByTestId('location')).toHaveTextContent('/memory null')
    })

    test('the appMenu state is ignored on desktop', () => {
        renderAt({ pathname: '/chat', state: { appMenu: true } })
        expect(screen.queryByTestId('l1-menu')).not.toBeInTheDocument()
    })
})
