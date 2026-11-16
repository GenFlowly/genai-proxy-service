import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from '../../../components/navbar/Navbar';
import { useAuth } from '../../../context/AuthContext';
import { LayoutProvider } from '../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mock usages
jest.mock('../../../context/AuthContext');
jest.mock('../../../components/common/ThemeToggle/ThemeToggle', () => () => <div data-testid="theme-toggle-mock" />);
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

    test('shows a placeholder instead of the login button while onboarding', () => {
        mockUseAuth.mockReturnValue({
            ...defaultAuthValues,
            isAuthenticated: false,
            isOnboarding: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <LayoutProvider><Navbar /></LayoutProvider>
            </MemoryRouter>
        );

        expect(screen.getByTestId('auth-onboarding-placeholder')).toBeInTheDocument();
        expect(screen.queryByTestId('login-button')).not.toBeInTheDocument();
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

    test('the logo and the avatar say what they do on hover', () => {
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

        fireEvent.mouseEnter(screen.getByTestId('navbar-logo-link').parentElement!);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Home');
        fireEvent.mouseLeave(screen.getByTestId('navbar-logo-link').parentElement!);

        const avatar = screen.getByTestId('user-avatar-button');
        expect(avatar).not.toHaveAttribute('title');
        fireEvent.mouseEnter(avatar.parentElement!);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
    });

    test('navigates to settings on avatar click', async () => {
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

        // Click avatar
        await userEvent.click(screen.getByTestId('user-avatar-button'));
        expect(mockNavigate).toHaveBeenCalledWith('/settings');
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
    });
});
// Trigger coverage run
