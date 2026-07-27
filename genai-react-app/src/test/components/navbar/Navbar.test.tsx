import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../../components/navbar/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { LayoutProvider } from '../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mock usages
jest.mock('../../../context/AuthContext');
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

describe('Navbar Component', () => {
    const mockUseAuth = useAuth as jest.Mock;
    const mockLoginWithRedirect = jest.fn();
    const mockLogout = jest.fn();

    const defaultAuthValues = {
        loginWithRedirect: mockLoginWithRedirect,
        logout: mockLogout,
        isAuthenticated: false,
        user: null,
        customerPicture: null,
        customerName: null,
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders login button when not authenticated', () => {
        mockUseAuth.mockReturnValue(defaultAuthValues);

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        const loginBtn = screen.getByTestId('login-button');
        expect(loginBtn).toBeInTheDocument();
        expect(screen.queryByTestId('user-avatar-button')).not.toBeInTheDocument();
    });

    test('calls loginWithRedirect when login button is clicked', async () => {
        mockUseAuth.mockReturnValue(defaultAuthValues);

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        await userEvent.click(screen.getByTestId('login-button'));
        expect(mockLoginWithRedirect).toHaveBeenCalledTimes(1);
    });

    test('renders user avatar when authenticated', () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User', picture: 'pic.jpg' },
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        expect(screen.queryByTestId('login-button')).not.toBeInTheDocument();
        const avatarBtn = screen.getByTestId('user-avatar-button');
        expect(avatarBtn).toBeInTheDocument();
    });

    test('toggles dropdown menu on avatar click', async () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        const avatarBtn = screen.getByTestId('user-avatar-button');

        // Initial state: closed
        expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();

        // Click to open
        await userEvent.click(avatarBtn);
        expect(screen.getByTestId('settings-button')).toBeInTheDocument();
        expect(screen.getByTestId('user-name-display')).toHaveTextContent('Hello Test User 👋');

        // Click to close
        await userEvent.click(avatarBtn);
        expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
    });

    test('navigates to settings and closes dropdown', async () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        // Open menu
        await userEvent.click(screen.getByTestId('user-avatar-button'));

        // Click settings
        await userEvent.click(screen.getByTestId('settings-button'));

        expect(mockNavigate).toHaveBeenCalledWith('/settings');
        expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
    });

    test('calls logout', async () => {
        const origin = 'http://localhost';
        Object.defineProperty(window, 'location', {
            value: { origin },
            writable: true
        });

        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        // Open menu
        await userEvent.click(screen.getByTestId('user-avatar-button'));

        // Click logout
        await userEvent.click(screen.getByTestId('logout-button'));

        expect(mockLogout).toHaveBeenCalledWith({ returnTo: origin });
    });

    test('closes dropdown when clicking outside', async () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <div data-testid="outside">Outside</div>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        // Open menu
        await userEvent.click(screen.getByTestId('user-avatar-button'));
        expect(screen.getByTestId('settings-button')).toBeInTheDocument();

        // Click outside
        await userEvent.click(screen.getByTestId('outside'));

        expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
    });

    test('handles focus navigation (unauthenticated)', async () => {
        mockUseAuth.mockReturnValue(defaultAuthValues);

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        const loginBtn = screen.getByTestId('login-button');

        // Tab to login button
        // Due to potential sidebar toggles (visible in JSDOM) and logo link, we tab until we reach the button
        for (let i = 0; i < 15; i++) {
            if (document.activeElement === loginBtn) break;
            await userEvent.tab();
        }

        expect(loginBtn).toHaveFocus();
    });

    test('handles focus navigation (authenticated)', async () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: true,
            user: { name: 'Test User' }
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        const avatarBtn = screen.getByTestId('user-avatar-button');

        // Focus avatar
        for (let i = 0; i < 15; i++) {
            if (document.activeElement === avatarBtn) break;
            await userEvent.tab();
        }
        expect(avatarBtn).toHaveFocus();


        // Open menu with enter or space (simulating keyboard interaction if button supports it, or just click)
        await userEvent.click(avatarBtn);

        // Tab to Settings
        await userEvent.tab();
        const settingsBtn = screen.getByTestId('settings-button');
        expect(settingsBtn).toHaveFocus();

        // Tab to Logout
        await userEvent.tab();
        const logoutBtn = screen.getByTestId('logout-button');
        expect(logoutBtn).toHaveFocus();
    });
});
