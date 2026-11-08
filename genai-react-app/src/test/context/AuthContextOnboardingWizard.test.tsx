import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom'
import { AuthProvider, useAuth } from '../../context/AuthContext'
import { LayoutProvider } from '../../context/LayoutContext'
import { MOCK_USER } from '../fixtures/auth0'
import { mockOnboardResponse } from '../fixtures/customerProfile'
import { onboardCustomer } from '../../services/onboardUserService'
import { acceptAiDataConsent as acceptAiDataConsentRequest, completeOnboarding as completeOnboardingRequest } from '../../services/userService'

const mockUseAuth0 = jest.fn()
jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => mockUseAuth0(),
}))

jest.mock('../../services/onboardUserService', () => ({
    onboardCustomer: jest.fn(),
}))

jest.mock('../../services/userService', () => ({
    ...jest.requireActual('../../services/userService'),
    completeOnboarding: jest.fn(),
    acceptAiDataConsent: jest.fn(),
}))

jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn(),
}))

function TestOnboardingState() {
    const { onboardingCompleted, completeOnboarding, aiDataConsentRequired, aiDataConsentAt, acceptAiDataConsent } = useAuth()
    const [error, setError] = React.useState<string | null>(null)
    return (
        <div>
            <div data-testid="onboarding-completed-value">{String(onboardingCompleted)}</div>
            <button
                data-testid="complete-onboarding-btn"
                onClick={() => {
                    setError(null)
                    completeOnboarding().catch(err => setError(err.message))
                }}
            >
                Complete
            </button>
            <div data-testid="complete-onboarding-error">{error ?? ''}</div>
            <div data-testid="consent-required">{String(aiDataConsentRequired)}</div>
            <div data-testid="consent-at">{aiDataConsentAt ?? ''}</div>
            <button
                data-testid="accept-consent-btn"
                onClick={() => {
                    setError(null)
                    acceptAiDataConsent().catch(err => setError(err.message))
                }}
            >
                Agree
            </button>
        </div>
    )
}

function renderWithProvider() {
    return render(
        <MemoryRouter>
            <LayoutProvider>
                <AuthProvider>
                    <TestOnboardingState />
                </AuthProvider>
            </LayoutProvider>
        </MemoryRouter>
    )
}

describe('AuthContext onboarding wizard state', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        localStorage.clear()
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: MOCK_USER,
            getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
            logout: jest.fn(),
        })
    })

    test('aiDataConsentRequired follows /onboard', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, aiDataConsentRequired: true })

        renderWithProvider()

        await waitFor(() => expect(screen.getByTestId('consent-required')).toHaveTextContent('true'))
    })

    test('a backend that omits the field never asks', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse })

        renderWithProvider()

        await waitFor(() => expect(onboardCustomer).toHaveBeenCalled())
        await waitFor(() => expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('true'))
        expect(screen.getByTestId('consent-required')).toHaveTextContent('false')
    })

    test('acceptAiDataConsent() records the agreement and lifts the gate', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, aiDataConsentRequired: true })
        ;(acceptAiDataConsentRequest as jest.Mock).mockResolvedValue('2026-11-08T21:00:00Z')

        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('consent-required')).toHaveTextContent('true'))

        act(() => { screen.getByTestId('accept-consent-btn').click() })

        await waitFor(() => expect(screen.getByTestId('consent-required')).toHaveTextContent('false'))
        expect(acceptAiDataConsentRequest).toHaveBeenCalledWith('token')
        expect(screen.getByTestId('consent-at')).toHaveTextContent('2026-11-08T21:00:00Z')
    })

    test('acceptAiDataConsent() keeps the gate up when the backend call fails', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, aiDataConsentRequired: true })
        ;(acceptAiDataConsentRequest as jest.Mock).mockRejectedValue(new Error('network down'))

        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('consent-required')).toHaveTextContent('true'))

        act(() => { screen.getByTestId('accept-consent-btn').click() })

        await waitFor(() => expect(screen.getByTestId('complete-onboarding-error')).toHaveTextContent('network down'))
        expect(screen.getByTestId('consent-required')).toHaveTextContent('true')
    })

    test('onboardingCompleted reflects false for a brand-new account', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, onboardingCompleted: false })

        renderWithProvider()

        await waitFor(() => {
            expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('false')
        })
    })

    test('onboardingCompleted reflects true for an already-onboarded account', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, onboardingCompleted: true })

        renderWithProvider()

        await waitFor(() => {
            expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('true')
        })
    })

    test('completeOnboarding() calls the backend and flips onboardingCompleted to true', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, onboardingCompleted: false })
        ;(completeOnboardingRequest as jest.Mock).mockResolvedValue(true)

        renderWithProvider()
        await waitFor(() => {
            expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('false')
        })

        await act(async () => {
            screen.getByTestId('complete-onboarding-btn').click()
        })

        expect(completeOnboardingRequest).toHaveBeenCalledWith('token')
        await waitFor(() => {
            expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('true')
        })
    })

    test('completeOnboarding() rethrows and leaves onboardingCompleted false when the backend call fails', async () => {
        (onboardCustomer as jest.Mock).mockResolvedValue({ ...mockOnboardResponse, onboardingCompleted: false })
        ;(completeOnboardingRequest as jest.Mock).mockRejectedValue(new Error('network down'))

        renderWithProvider()
        await waitFor(() => {
            expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('false')
        })

        await act(async () => {
            screen.getByTestId('complete-onboarding-btn').click()
        })

        await waitFor(() => {
            expect(screen.getByTestId('complete-onboarding-error')).toHaveTextContent('network down')
        })
        expect(screen.getByTestId('onboarding-completed-value')).toHaveTextContent('false')
    })
})
