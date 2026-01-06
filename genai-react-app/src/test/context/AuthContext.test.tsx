import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../context/AuthContext';
import { MOCK_USER, AUTH0_TOKEN_RESPONSE } from '../fixtures/auth0';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../components/navbar/Navbar';
import { mockOnboardResponse } from '../fixtures/customerProfile'; // Import here to be available in scope
import { onboardCustomer } from '../../services/onboardUserService';
// We need to mock useAuth0 to control returned values per test
const mockUseAuth0 = jest.fn();

jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => mockUseAuth0(),
}));

// Mock the onboarding service to prevent side effects/errors in console
jest.mock('../../services/onboardUserService', () => ({
    onboardCustomer: jest.fn()
}));

describe('AuthContext Integration with Navbar', () => {
    beforeEach(() => {
        mockUseAuth0.mockReset();
        (onboardCustomer as jest.Mock).mockResolvedValue(mockOnboardResponse);
    });

    test('Shows Login button when unauthenticated', async () => {
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: false,
            user: null,
            getAccessTokenSilently: jest.fn(),
        });

        render(
            <MemoryRouter>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </MemoryRouter>
        );

        expect(screen.getByTestId('login-button')).toBeInTheDocument();
        expect(screen.queryByTestId('user-avatar-button')).not.toBeInTheDocument();
    });

    test('Shows User Avatar when authenticated and accesses User Profile', async () => {
        const mockGetToken = jest.fn().mockResolvedValue(AUTH0_TOKEN_RESPONSE.access_token);

        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: MOCK_USER,
            getAccessTokenSilently: mockGetToken,
        });

        render(
            <MemoryRouter>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </MemoryRouter>
        );

        // 1. Verify Avatar Present
        const avatarBtn = await screen.findByTestId('user-avatar-button');
        expect(avatarBtn).toBeInTheDocument();
        expect(screen.queryByTestId('login-button')).not.toBeInTheDocument();

        // 2. Open Dropdown
        act(() => {
            avatarBtn.click();
        });

        // 3. Verify User Name
        const userNameDisplay = await screen.findByTestId('user-name-display');
        expect(userNameDisplay).toHaveTextContent(`Hello ${MOCK_USER.name}`);

        // 4. Verify Token Fetch (AuthContext internal behavior)
        // This confirms AuthContext did its initialization
        await waitFor(() => {
            expect(mockGetToken).toHaveBeenCalled();
        });
    });


    test('Login button calls loginWithRedirect', async () => {
        const mockLogin = jest.fn();
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: false,
            user: null, // User is null
            loginWithRedirect: mockLogin,
            getAccessTokenSilently: jest.fn(),
        });

        render(
            <MemoryRouter>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </MemoryRouter>
        );

        const loginBtn = screen.getByTestId('login-button');
        act(() => {
            loginBtn.click();
        });

        expect(mockLogin).toHaveBeenCalled();
    });

    test('Logs out if Auth0 succeeds and onboard API fails', async () => {
        // 1. Setup mocks for failure
        const mockError = new Error('API Error');
        (onboardCustomer as jest.Mock).mockRejectedValue(mockError);

        const mockGetToken = jest.fn().mockResolvedValue('token');
        const mockLogout = jest.fn();
        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: MOCK_USER,
            getAccessTokenSilently: mockGetToken,
            logout: mockLogout,
        });

        // 2. Render
        render(
            <MemoryRouter>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </MemoryRouter>
        );

        // 3. Verify Logout is called to clear Auth0 session/localStorage
        // We wait for this side effect since the onboard call is async
        await waitFor(() => {
            expect(mockLogout).toHaveBeenCalledWith({ logoutParams: { returnTo: window.location.origin } });
        });

    });

    test('Strictly uses Backend Profile data over Auth0 data', async () => {
        // 1. Setup: Auth0 says "Alice", Backend says "Bob"
        const auth0User = { ...MOCK_USER, name: 'Alice', picture: 'alice.jpg' };
        const backendResponse = {
            ...mockOnboardResponse,
            customerName: 'Bob',
            customerPicture: 'bob.jpg'
        };

        const mockGetToken = jest.fn().mockResolvedValue('token');
        (onboardCustomer as jest.Mock).mockResolvedValue(backendResponse);

        mockUseAuth0.mockReturnValue({
            isLoading: false,
            isAuthenticated: true,
            user: auth0User,
            getAccessTokenSilently: mockGetToken,
        });

        // 2. Render
        render(
            <MemoryRouter>
                <AuthProvider>
                    <Navbar />
                </AuthProvider>
            </MemoryRouter>
        );

        // 3. Open Profile Dropdown
        const avatarBtn = await screen.findByTestId('user-avatar-button');
        act(() => {
            avatarBtn.click();
        });

        // 4. Verify Display Name is from Backend ("Bob"), NOT Auth0 ("Alice")
        const userNameDisplay = await screen.findByTestId('user-name-display');
        expect(userNameDisplay).toHaveTextContent('Hello Bob');
        expect(userNameDisplay).not.toHaveTextContent('Alice');

        // Verify Avatar image source (UserAvatarButton uses displayPicture)
        // Note: checking src might be tricky if Avatar component handles it internally,
        // but we can check checking the prop passed if we mocked it, or check the img tag if strictly rendered.
        // UserAvatarButton renders an img if displayPicture is present.
        // UserAvatarButton renders an img if displayPicture is present.
        const img = screen.getByTestId('user-avatar-image');
        expect(img).toHaveAttribute('src', 'bob.jpg');
        expect(img).toHaveAttribute('alt', 'Bob');
    });
});
