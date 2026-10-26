import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '@testing-library/jest-dom'
import { AuthProvider, useAuth } from '../../context/AuthContext'
import { LayoutProvider } from '../../context/LayoutContext'
import { MOCK_USER } from '../fixtures/auth0'
import { mockOnboardResponse } from '../fixtures/customerProfile'
import { onboardCustomer } from '../../services/onboardUserService'
import { completeOnboarding as completeOnboardingRequest } from '../../services/userService'

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
}))

jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: jest.fn(),
}))

function TestOnboardingState() {
    const { onboardingCompleted, completeOnboarding } = useAuth()
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
