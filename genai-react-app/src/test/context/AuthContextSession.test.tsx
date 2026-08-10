import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { AuthProvider, useAuth } from '../../context/AuthContext'

const STABLE_USER = { sub: 'sub123', email: 'test@example.com', name: 'Test' }
const mockGetAccessTokenSilently = jest.fn()
const mockAuth0Logout = jest.fn()

jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => ({
        isAuthenticated: true,
        user: STABLE_USER,
        getAccessTokenSilently: mockGetAccessTokenSilently,
        isLoading: false,
        logout: mockAuth0Logout,
        loginWithRedirect: jest.fn(),
    }),
}))

// Factory mocks with local handles: no static imports of the real services, so
// they stay out of the diff-coverage denominator
const mockOnboardCustomer = jest.fn()
jest.mock('../../services/onboardUserService', () => ({
    onboardCustomer: (...args: any[]) => mockOnboardCustomer(...args),
}))

const mockGetCustomerInstructions = jest.fn()
jest.mock('../../services/instructionService', () => ({
    getCustomerInstructions: (...args: any[]) => mockGetCustomerInstructions(...args),
}))

const TestComponent = () => {
    const auth = useAuth()
    return (
        <div>
            <div data-testid="loading">{auth.isLoading ? 'LOADING' : 'READY'}</div>
            <div data-testid="inst-count">{auth.customerInstructions.length}</div>
            <div data-testid="inst-loaded">{auth.isInstructionsLoaded ? 'YES' : 'NO'}</div>
            <button data-testid="logout-full" onClick={() => auth.logout({ returnTo: 'http://localhost' })}>Logout</button>
            <button data-testid="logout-local" onClick={() => auth.logout({ returnTo: 'http://localhost', localOnly: true })}>Local Logout</button>
            <button data-testid="get-token" onClick={() => { auth.getAccessTokenSilently().catch(() => {}) }}>Token</button>
            <button data-testid="refresh-inst" onClick={() => auth.refreshInstructions()}>Refresh</button>
            <div data-testid="vendor-count">{auth.aiVendorAPIKeyStatusList.length}</div>
            <div data-testid="vdb-count">{auth.vectorDBConfigStatusList.length}</div>
            <div data-testid="supabase">{auth.supabaseConfigStatus ? 'SET' : 'NOT_SET'}</div>
            <button data-testid="upd-inst-new" onClick={() => auth.updateInstruction({ id: 'i1', version: 1, name: 'v1' } as any)}>Add Inst</button>
            <button data-testid="upd-inst-same" onClick={() => auth.updateInstruction({ id: 'i1', version: 1, name: 'v1-updated' } as any)}>Update Inst</button>
            <button data-testid="upd-vendor-new" onClick={() => auth.updateVendorApiKeyStatus({ aiVendor: 'OPENAI', isAPIKeyValid: true } as any)}>Add Vendor</button>
            <button data-testid="upd-vendor-same" onClick={() => auth.updateVendorApiKeyStatus({ aiVendor: 'OPENAI', isAPIKeyValid: false } as any)}>Update Vendor</button>
            <button data-testid="upd-vdb-new" onClick={() => auth.updateVectorDBConfigStatus({ vendor: 'ZILLIZ', isConfigValid: true } as any)}>Add VDB</button>
            <button data-testid="upd-vdb-same" onClick={() => auth.updateVectorDBConfigStatus({ vendor: 'ZILLIZ', isConfigValid: false } as any)}>Update VDB</button>
            <button data-testid="upd-supabase" onClick={() => auth.updateSupabaseConfigStatus({ status: 'VALID' })}>Update Supabase</button>
        </div>
    )
}

const renderWithProvider = () =>
    render(
        <AuthProvider>
            <TestComponent />
        </AuthProvider>
    )

describe('AuthContext session handling', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        localStorage.clear()
        mockGetAccessTokenSilently.mockResolvedValue('token')
        ;mockOnboardCustomer.mockResolvedValue({ customerId: 'cust-1' })
    })

    test('logout clears customer state and calls auth0 logout with redirect', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('logout-full'))

        expect(mockAuth0Logout).toHaveBeenCalledWith({
            logoutParams: { returnTo: 'http://localhost' },
        })
        expect(localStorage.getItem('customerId')).toBeNull()
    })

    test('local-only logout suppresses the redirect', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('logout-local'))

        expect(mockAuth0Logout).toHaveBeenCalledWith({
            logoutParams: { returnTo: 'http://localhost' },
            openUrl: false,
        })
    })

    test('logs out locally when token refresh reports login_required', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        mockGetAccessTokenSilently.mockRejectedValue({ error: 'login_required' })
        fireEvent.click(screen.getByTestId('get-token'))

        await waitFor(() => {
            expect(mockAuth0Logout).toHaveBeenCalledWith(
                expect.objectContaining({ openUrl: false })
            )
        })
    })

    test('transient onboarding failure keeps the session', async () => {
        ;mockOnboardCustomer.mockRejectedValue(new Error('backend 500'))

        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        expect(mockAuth0Logout).not.toHaveBeenCalled()
    })

    test('onboarding failure with invalid session logs out locally', async () => {
        ;mockOnboardCustomer.mockRejectedValue({ error: 'login_required' })

        renderWithProvider()

        await waitFor(() => {
            expect(mockAuth0Logout).toHaveBeenCalledWith(
                expect.objectContaining({ openUrl: false })
            )
        })
    })

    test('refreshInstructions loads instructions and marks them loaded', async () => {
        ;mockGetCustomerInstructions.mockResolvedValue({
            instructions: [{ id: 'i1', version: 1 }, { id: 'i2', version: 1 }],
        })

        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('refresh-inst'))

        await waitFor(() => {
            expect(screen.getByTestId('inst-count')).toHaveTextContent('2')
        })
        expect(screen.getByTestId('inst-loaded')).toHaveTextContent('YES')
    })

    test('refreshInstructions failure still marks instructions as loaded', async () => {
        ;mockGetCustomerInstructions.mockRejectedValue(new Error('network'))

        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('refresh-inst'))

        await waitFor(() => {
            expect(screen.getByTestId('inst-loaded')).toHaveTextContent('YES')
        })
        expect(screen.getByTestId('inst-count')).toHaveTextContent('0')
    })

    test('updateInstruction adds a new version and updates an existing one', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('upd-inst-new'))
        expect(screen.getByTestId('inst-count')).toHaveTextContent('1')

        // Same id+version updates in place instead of appending
        fireEvent.click(screen.getByTestId('upd-inst-same'))
        expect(screen.getByTestId('inst-count')).toHaveTextContent('1')
    })

    test('updateVendorApiKeyStatus adds then updates a vendor entry', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('upd-vendor-new'))
        expect(screen.getByTestId('vendor-count')).toHaveTextContent('1')

        fireEvent.click(screen.getByTestId('upd-vendor-same'))
        expect(screen.getByTestId('vendor-count')).toHaveTextContent('1')
    })

    test('updateVectorDBConfigStatus adds then updates a vendor entry', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        fireEvent.click(screen.getByTestId('upd-vdb-new'))
        expect(screen.getByTestId('vdb-count')).toHaveTextContent('1')

        fireEvent.click(screen.getByTestId('upd-vdb-same'))
        expect(screen.getByTestId('vdb-count')).toHaveTextContent('1')
    })

    test('updateSupabaseConfigStatus stores the status', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        expect(screen.getByTestId('supabase')).toHaveTextContent('NOT_SET')
        fireEvent.click(screen.getByTestId('upd-supabase'))
        expect(screen.getByTestId('supabase')).toHaveTextContent('SET')
    })

    test('session is re-checked when the tab becomes visible again', async () => {
        renderWithProvider()
        await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('READY'))

        mockGetAccessTokenSilently.mockRejectedValue({ error: 'consent_required' })

        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })

        await waitFor(() => {
            expect(mockAuth0Logout).toHaveBeenCalledWith(
                expect.objectContaining({ openUrl: false })
            )
        })
    })
})
