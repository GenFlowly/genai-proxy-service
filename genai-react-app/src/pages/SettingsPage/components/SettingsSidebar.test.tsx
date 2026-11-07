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

    test('clicking a parent section expands it and navigates to its first child', async () => {
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <SettingsSidebar />
            </MemoryRouter>
        );

        // Collapsed to start: child links are not shown
        expect(screen.queryByText('LLM API Keys')).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('AI Settings'));

        expect(mockNavigate).toHaveBeenCalledWith('/settings/ai/llm-keys');
        // Submenu is now expanded in place (so a different child is one tap away)
        expect(screen.getByText('LLM API Keys')).toBeInTheDocument();
        expect(screen.getByText('Embedding Model API Keys')).toBeInTheDocument();
        expect(screen.getByText('Vector DB Connection')).toBeInTheDocument();
    });

    test('tapping a child navigates to its page and calls onNavigate', async () => {
        const onNavigate = jest.fn();
        render(
            <MemoryRouter initialEntries={['/settings/ai']}>
                <SettingsSidebar onNavigate={onNavigate} />
            </MemoryRouter>
        );

        await userEvent.click(screen.getByText('Vector DB Connection'));

        expect(mockNavigate).toHaveBeenCalledWith('/settings/ai/vector-db');
        expect(onNavigate).toHaveBeenCalled();
    });

    test('links to the support page above the logout button', async () => {
        const onNavigate = jest.fn();
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <SettingsSidebar onNavigate={onNavigate} />
            </MemoryRouter>
        );

        await userEvent.click(screen.getByTestId('settings-sidebar-support'));

        expect(mockNavigate).toHaveBeenCalledWith('/support');
        expect(onNavigate).toHaveBeenCalled();
    });

    describe('mobile menu', () => {
        const renderMenu = (onNavigate = jest.fn()) => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <SettingsSidebar menu onNavigate={onNavigate} />
                </MemoryRouter>
            );
            return onNavigate;
        };

        test('a section opens in place without navigating or closing the menu', async () => {
            const onNavigate = renderMenu();

            await userEvent.click(screen.getByText('AI Settings'));

            expect(screen.getByText('LLM API Keys')).toBeInTheDocument();
            expect(mockNavigate).not.toHaveBeenCalled();
            expect(onNavigate).not.toHaveBeenCalled();
        });

        test('a sub-page navigates and closes the menu', async () => {
            const onNavigate = renderMenu();

            await userEvent.click(screen.getByText('AI Settings'));
            await userEvent.click(screen.getByText('LLM API Keys'));

            expect(mockNavigate).toHaveBeenCalledWith('/settings/ai/llm-keys');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('search lists matching sections and sub-pages, and says when nothing matches', async () => {
            const onNavigate = renderMenu();
            const search = screen.getByTestId('mobile-menu-search');

            await userEvent.type(search, 'web search');
            expect(screen.queryByText('Profile')).not.toBeInTheDocument();
            await userEvent.click(screen.getByText('Web Search'));
            expect(mockNavigate).toHaveBeenCalledWith('/settings/usage/web-search');
            expect(onNavigate).toHaveBeenCalled();

            await userEvent.clear(search);
            await userEvent.type(search, 'zzz');
            expect(screen.getByText('No results')).toBeInTheDocument();
        });

        test('search matches sections without sub-pages', async () => {
            renderMenu();
            await userEvent.type(screen.getByTestId('mobile-menu-search'), 'tools');
            expect(screen.getByTestId('settings-search-hit-tools')).toBeInTheDocument();
        });

        test('opens the privacy policy and closes the menu', async () => {
            const onNavigate = renderMenu();
            await userEvent.click(screen.getByTestId('settings-menu-privacy-policy'));
            expect(mockNavigate).toHaveBeenCalledWith('/privacy-policy');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('opens the support page and closes the menu', async () => {
            const onNavigate = renderMenu();
            await userEvent.click(screen.getByTestId('settings-menu-support'));
            expect(mockNavigate).toHaveBeenCalledWith('/support');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('search finds the support page', async () => {
            const onNavigate = renderMenu();
            await userEvent.type(screen.getByTestId('mobile-menu-search'), 'supp');
            await userEvent.click(screen.getByTestId('settings-search-hit-support'));
            expect(mockNavigate).toHaveBeenCalledWith('/support');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('logs out from its own card', async () => {
            renderMenu();
            await userEvent.click(screen.getByTestId('settings-menu-logout'));
            expect(mockLogout).toHaveBeenCalled();
        });
    });
});
