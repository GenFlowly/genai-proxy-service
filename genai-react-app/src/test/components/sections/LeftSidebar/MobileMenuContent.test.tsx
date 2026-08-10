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

    test('tapping Conversation History closes the menu and opens the history page', () => {
        render(
            <MemoryRouter>
                <MobileMenuContent />
            </MemoryRouter>
        );

        fireEvent.click(screen.getByText('Conversation History'));

        expect(mockToggleLeftSidebar).toHaveBeenCalled();
        expect(mockNavigate).toHaveBeenCalledWith('/history');
    });
});
