import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSidebar } from './SettingsSidebar';
import { useAuth } from '../../../context/AuthContext';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../../context/AuthContext');

const mockUseAuth = useAuth as jest.Mock;

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate
}));

describe('SettingsSidebar', () => {
    const mockLogout = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseAuth.mockReturnValue({
            logout: mockLogout
        });
    });

    test('renders tabs and logout button', () => {
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <SettingsSidebar />
            </MemoryRouter>
        );
        
        expect(screen.getByText('Profile')).toBeInTheDocument();
        expect(screen.getByText('AI Settings')).toBeInTheDocument();
        expect(screen.getByText('Defaults')).toBeInTheDocument();
        expect(screen.getByText('Logout')).toBeInTheDocument();
    });

    test('calls navigate when clicking a tab', async () => {
        render(
            <MemoryRouter initialEntries={['/settings/ai']}>
                <SettingsSidebar />
            </MemoryRouter>
        );
        
        const profileTab = screen.getByText('Profile');
        await userEvent.click(profileTab);
        
        expect(mockNavigate).toHaveBeenCalledWith('/settings/profile');
    });

    test('calls logout when clicking logout button', async () => {
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <SettingsSidebar />
            </MemoryRouter>
        );
        
        const logoutButton = screen.getByText('Logout');
        await userEvent.click(logoutButton);
        
        expect(mockLogout).toHaveBeenCalledWith({ returnTo: window.location.origin });
    });

    test('defaults activeTab to profile when location pathname is /', () => {
        render(
            <MemoryRouter initialEntries={['/']}>
                <SettingsSidebar />
            </MemoryRouter>
        );

        const profileTab = screen.getByText('Profile').closest('button');
        expect(profileTab).toHaveClass('active');
    });

    test('desktop: clicking a parent section navigates to its first child', async () => {
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <SettingsSidebar />
            </MemoryRouter>
        );

        await userEvent.click(screen.getByText('AI Settings'));

        expect(mockNavigate).toHaveBeenCalledWith('/settings/ai/llm-keys');
    });

    test('mobile full page: tapping a parent expands the submenu without navigating', async () => {
        render(
            <MemoryRouter initialEntries={['/settings']}>
                <SettingsSidebar fullPage />
            </MemoryRouter>
        );

        // Collapsed to start: child links are not shown
        expect(screen.queryByText('LLM API Keys')).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('AI Settings'));

        // Submenu expands in place, and we stay on the menu page (no navigation)
        expect(screen.getByText('LLM API Keys')).toBeInTheDocument();
        expect(screen.getByText('Embedding Model API Keys')).toBeInTheDocument();
        expect(screen.getByText('Vector DB Connection')).toBeInTheDocument();
        expect(mockNavigate).not.toHaveBeenCalled();
    });

    test('mobile full page: tapping a child navigates to its page', async () => {
        render(
            <MemoryRouter initialEntries={['/settings']}>
                <SettingsSidebar fullPage />
            </MemoryRouter>
        );

        await userEvent.click(screen.getByText('AI Settings'));
        await userEvent.click(screen.getByText('Vector DB Connection'));

        expect(mockNavigate).toHaveBeenCalledWith('/settings/ai/vector-db');
    });
});
