import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ProtectedRoute } from '../../../components/auth/ProtectedRoute';
import { useAuth0 } from '@auth0/auth0-react';
import '@testing-library/jest-dom';

// Mock useAuth0 explicitly as a jest function for this test
jest.mock('@auth0/auth0-react', () => ({
    useAuth0: jest.fn()
}));

describe('ProtectedRoute', () => {
    const mockLoginWithRedirect = jest.fn();
    const mockUseAuth0 = useAuth0 as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseAuth0.mockReturnValue({
            isAuthenticated: false,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        });
    });

    test('renders loading state when isLoading is true', () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: false,
            isLoading: true,
            loginWithRedirect: mockLoginWithRedirect,
        });

        render(
            <ProtectedRoute>
                <div data-testid="child-component">Child Component</div>
            </ProtectedRoute>
        );

        expect(screen.getByTestId('protected-route-loading')).toBeInTheDocument();
        expect(screen.queryByTestId('child-component')).not.toBeInTheDocument();
    });

    test('redirects to login when unauthenticated and not loading', async () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: false,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        });

        render(
            <ProtectedRoute>
                <div data-testid="child-component">Child Component</div>
            </ProtectedRoute>
        );

        // Should return null (nothing rendered)
        expect(screen.queryByTestId('child-component')).not.toBeInTheDocument();
        expect(screen.queryByTestId('protected-route-loading')).not.toBeInTheDocument();

        // Check if loginWithRedirect is called
        await waitFor(() => {
            expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);
            expect(mockLoginWithRedirect).toHaveBeenCalledWith({
                appState: { returnTo: expect.any(String) }, // window.location.pathname might be '/' in test env
            });
        });
    });

    test('renders children when authenticated', () => {
        mockUseAuth0.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            loginWithRedirect: mockLoginWithRedirect,
        });

        render(
            <ProtectedRoute>
                <div data-testid="child-component">Child Component</div>
            </ProtectedRoute>
        );

        expect(screen.getByTestId('child-component')).toBeInTheDocument();
        expect(screen.queryByTestId('protected-route-loading')).not.toBeInTheDocument();
        expect(mockLoginWithRedirect).not.toHaveBeenCalled();
    });
});
