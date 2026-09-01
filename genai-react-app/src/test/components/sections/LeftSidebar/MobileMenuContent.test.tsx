import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MobileMenuContent } from '../../../../components/sections/LeftSidebar/MobileMenuContent';
import { useAuth } from '../../../../context/AuthContext';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

jest.mock('../../../../context/LayoutContext', () => ({
    useLayout: jest.fn(),
}));

jest.mock('../../../../components/widgets/NavbarMenuWidget/NavbarMenu', () => ({
    NavbarMenu: () => <div data-testid="mock-navbar-menu" />,
}));

jest.mock('../../../../components/common/ThemeToggle/ThemeToggle', () => () => <div data-testid="mock-theme-toggle" />);

describe('MobileMenuContent', () => {
    const mockToggleLeftSidebar = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();

        (useAuth as jest.Mock).mockReturnValue({
            loginWithRedirect: jest.fn(),
            isAuthenticated: false,
            user: null,
        });

        (useLayout as jest.Mock).mockReturnValue({
            toggleLeftSidebar: mockToggleLeftSidebar,
        });
    });

    test('shows a placeholder instead of the login button while onboarding', () => {
        (useAuth as jest.Mock).mockReturnValue({
            loginWithRedirect: jest.fn(),
            isAuthenticated: false,
            isOnboarding: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <MobileMenuContent />
            </MemoryRouter>
        );

        expect(screen.getByTestId('auth-onboarding-placeholder-mobile')).toBeInTheDocument();
        expect(screen.queryByText('Login')).not.toBeInTheDocument();
    });

    test('no longer offers a Conversation History entry (context menus own it)', () => {
        render(
            <MemoryRouter>
                <MobileMenuContent />
            </MemoryRouter>
        );

        expect(screen.queryByText('Conversation History')).not.toBeInTheDocument();
        expect(screen.getByTestId('mock-navbar-menu')).toBeInTheDocument();
    });

    test('close button closes the menu', () => {
        render(
            <MemoryRouter>
                <MobileMenuContent />
            </MemoryRouter>
        );

        fireEvent.click(screen.getByLabelText('Close menu'));
        expect(mockToggleLeftSidebar).toHaveBeenCalled();
    });

    test('account button closes the menu and opens settings', () => {
        (useAuth as jest.Mock).mockReturnValue({
            loginWithRedirect: jest.fn(),
            isAuthenticated: true,
            user: { name: 'Test User' },
        });

        render(
            <MemoryRouter>
                <MobileMenuContent />
            </MemoryRouter>
        );

        fireEvent.click(screen.getByText('Test User'));
        expect(mockToggleLeftSidebar).toHaveBeenCalled();
        expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });
});
