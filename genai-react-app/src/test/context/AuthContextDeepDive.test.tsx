import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { onboardCustomer } from '../../services/onboardUserService';

// Standard mocks
jest.mock('../../services/onboardUserService');
const mockOnboardCustomer = onboardCustomer as jest.Mock;

const mockLoginWithRedirect = jest.fn();
const mockLogout = jest.fn();
const mockGetAccessTokenSilently = jest.fn();

const STABLE_USER = { sub: 'sub123', email: 'test@example.com', name: 'Test User' };

// Locally override Auth0 mock to control states with STABLE objects
jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => ({
        isAuthenticated: true,
        user: STABLE_USER,
        isLoading: false,
        loginWithRedirect: mockLoginWithRedirect,
        logout: mockLogout,
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

// Test component to consume context
const TestComponent = () => {
    const auth = useAuth();
    return (
        <div>
            <div data-testid="customer-id">{auth.customerId}</div>
            <div data-testid="auth-status">{auth.isAuthenticated ? 'Authenticated' : 'Not Authenticated'}</div>
            <button onClick={() => auth.refreshInstructions()} data-testid="refresh-btn">Refresh</button>
            <button onClick={() => auth.logout({ returnTo: 'http://localhost' })} data-testid="logout-btn">Logout</button>
        </div>
    );
};

describe('AuthContext Deep Dive', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
    });

    test('handles onboarding success with full data', async () => {
        mockGetAccessTokenSilently.mockResolvedValue('token123');
        mockOnboardCustomer.mockResolvedValue({
            customerId: 'cust_abc',
            aiVendorAPIKeyStatusList: [],
            customerInstructions: [{ id: '1', version: 1, text: 'hi', name: 'hi' }],
            aiConfigPreferences: { theme: 'dark' }
        });

        render(<AuthProvider><TestComponent /></AuthProvider>);

        await waitFor(() => {
            expect(screen.getByTestId('customer-id')).toHaveTextContent('cust_abc');
        }, { timeout: 2000 });

        expect(localStorage.getItem('cust_abc_ai_preferences')).toContain('dark');
    });

    test('handles onboarding failure with login_required error', async () => {
        mockGetAccessTokenSilently.mockRejectedValue({ error: 'login_required' });

        render(<AuthProvider><TestComponent /></AuthProvider>);

        await waitFor(() => {
            expect(mockLogout).toHaveBeenCalled();
        }, { timeout: 2000 });
    });

    test('refreshInstructions successfully updates state', async () => {
        // Mock getCustomerInstructions inside the test
        jest.mock('../../services/instructionService', () => ({
            getCustomerInstructions: jest.fn().mockResolvedValue({ instructions: [{ id: '2', version: 1 }] })
        }));

        mockGetAccessTokenSilently.mockResolvedValue('token123');
        mockOnboardCustomer.mockResolvedValue({ customerId: 'cust_abc' });

        render(<AuthProvider><TestComponent /></AuthProvider>);

        await waitFor(() => {
            expect(screen.getByTestId('customer-id')).toHaveTextContent('cust_abc');
        }, { timeout: 2000 });

        const refreshBtn = screen.getByTestId('refresh-btn');
        fireEvent.click(refreshBtn);

        await waitFor(() => {
            // Once for onboarding, once for refresh
            expect(mockGetAccessTokenSilently).toHaveBeenCalledTimes(2);
        });
    });
});
