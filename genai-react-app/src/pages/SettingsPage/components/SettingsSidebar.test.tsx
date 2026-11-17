import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SettingsSidebar } from './SettingsSidebar';
import { useAuth } from '../../../context/AuthContext';

jest.mock('../../../context/AuthContext');

const mockUseAuth = useAuth as jest.Mock;
const mockNavigate = jest.fn();
jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    useNavigate: () => mockNavigate,
}));

const renderAt = (path: string, props: React.ComponentProps<typeof SettingsSidebar> = {}) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <SettingsSidebar {...props} />
        </MemoryRouter>
    );

describe('SettingsSidebar', () => {
    const logout = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseAuth.mockReturnValue({ logout });
    });

    describe('desktop', () => {
        test('lists the five sections with search and only Logout in the footer', () => {
            renderAt('/settings/profile/account');

            for (const label of ['Profile', 'BYOK Settings', 'Defaults', 'Cost and Usage', 'Developer']) {
                expect(screen.getByText(label)).toBeInTheDocument();
            }
            expect(screen.getByTestId('settings-sidebar-search')).toBeInTheDocument();
            expect(screen.getByTestId('settings-sidebar-logout')).toBeInTheDocument();
            expect(screen.queryByText('Support')).not.toBeInTheDocument();
            expect(screen.queryByText('Privacy policy')).not.toBeInTheDocument();
            expect(screen.queryByText('Tools')).not.toBeInTheDocument();
            expect(screen.queryByText('Connectors')).not.toBeInTheDocument();
        });

        test('the current page is open and marked', () => {
            renderAt('/settings/byok/vector-db');

            expect(screen.getByTestId('settings-page-byok-vector-db')).toHaveAttribute('aria-current', 'page');
            expect(screen.getByTestId('settings-section-byok')).toHaveAttribute('aria-expanded', 'true');
        });

        test('opening a section goes to its first page', async () => {
            const onNavigate = jest.fn();
            renderAt('/settings/profile/account', { onNavigate });

            await userEvent.click(screen.getByTestId('settings-section-usage'));

            expect(mockNavigate).toHaveBeenCalledWith('/settings/usage/llm-models');
            expect(screen.getByText('Embedding Models')).toBeInTheDocument();
        });

        test('a page navigates and reports it', async () => {
            const onNavigate = jest.fn();
            renderAt('/settings/byok/llm-keys', { onNavigate });

            await userEvent.click(screen.getByTestId('settings-page-byok-web-search'));

            expect(mockNavigate).toHaveBeenCalledWith('/settings/byok/web-search');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('Developer has no sub-pages and goes straight there', async () => {
            renderAt('/settings/profile/account');

            await userEvent.click(screen.getByTestId('settings-page-developer'));

            expect(mockNavigate).toHaveBeenCalledWith('/settings/developer');
        });

        test('search finds pages by their own or their section name', async () => {
            renderAt('/settings/profile/account');

            await userEvent.type(screen.getByTestId('settings-sidebar-search'), 'vector');

            expect(screen.getByTestId('settings-search-hit-byok-vector-db')).toBeInTheDocument();
            expect(screen.getByTestId('settings-search-hit-usage-vector-db')).toBeInTheDocument();
            expect(screen.queryByTestId('settings-search-hit-support')).not.toBeInTheDocument();
        });

        test('logs out', async () => {
            renderAt('/settings/profile/account');

            await userEvent.click(screen.getByTestId('settings-sidebar-logout'));

            expect(logout).toHaveBeenCalledWith({ returnTo: window.location.origin });
        });
    });

    describe('phone menu', () => {
        const setupMenu = (onNavigate = jest.fn()) => {
            renderAt('/settings/profile/account', { menu: true, onNavigate });
            return onNavigate;
        };

        test('a section opens in place without navigating or closing the menu', async () => {
            const onNavigate = setupMenu();

            await userEvent.click(screen.getByTestId('settings-section-byok'));

            expect(screen.getByText('LLM API Keys')).toBeInTheDocument();
            expect(mockNavigate).not.toHaveBeenCalled();
            expect(onNavigate).not.toHaveBeenCalled();
        });

        test('a page navigates and closes the menu', async () => {
            const onNavigate = setupMenu();

            await userEvent.click(screen.getByTestId('settings-section-byok'));
            await userEvent.click(screen.getByText('LLM API Keys'));

            expect(mockNavigate).toHaveBeenCalledWith('/settings/byok/llm-keys');
            expect(onNavigate).toHaveBeenCalled();
        });

        test('search lists matches, and says when nothing matches', async () => {
            const onNavigate = setupMenu();
            const search = screen.getByTestId('mobile-menu-search');

            await userEvent.type(search, 'web search');
            await userEvent.click(screen.getByTestId('settings-search-hit-usage-web-search'));
            expect(mockNavigate).toHaveBeenCalledWith('/settings/usage/web-search');
            expect(onNavigate).toHaveBeenCalled();

            await userEvent.clear(search);
            await userEvent.type(search, 'zzz');
            expect(screen.getByText('No results')).toBeInTheDocument();
        });

        test('the footer card opens Support and the privacy policy, and hides while searching', async () => {
            const onNavigate = setupMenu();

            await userEvent.click(screen.getByTestId('settings-menu-support'));
            expect(mockNavigate).toHaveBeenCalledWith('/support');
            await userEvent.click(screen.getByTestId('settings-menu-privacy-policy'));
            expect(mockNavigate).toHaveBeenCalledWith('/privacy-policy');
            expect(onNavigate).toHaveBeenCalledTimes(2);

            await userEvent.type(screen.getByTestId('mobile-menu-search'), 'supp');
            expect(screen.queryByTestId('settings-menu-support')).not.toBeInTheDocument();
            await userEvent.click(screen.getByTestId('settings-search-hit-support'));
            expect(mockNavigate).toHaveBeenLastCalledWith('/support');
        });

        test('logs out from the footer card', async () => {
            setupMenu();

            await userEvent.click(screen.getByTestId('settings-menu-logout'));

            expect(logout).toHaveBeenCalled();
        });
    });
});
