import React, { useEffect } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import SettingsPage from './SettingsPage';
import { useSettingsShell } from './SettingsShellContext';

jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
// The real MobileHeader drives the hamburger overlay via LayoutContext and is
// covered by its own suite; here we only check what SettingsPage passes it.
jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title, subtitle, menuContent, trailingAction }: any) => (
        <div data-testid="mobile-header">
            <span data-testid="mobile-header-title">{title}</span>
            <span data-testid="mobile-header-subtitle">{subtitle}</span>
            {trailingAction && (
                <button data-testid={trailingAction['data-testid']} aria-label={trailingAction.label} onClick={trailingAction.onClick} />
            )}
            <div data-testid="mobile-header-menu-content">{menuContent}</div>
        </div>
    ),
}));

// Pages are stubs; one reports a status and knowledge the way SettingsFrame does
jest.mock('./components/profile/AccountSettings', () => ({ AccountSettings: () => <div data-testid="page-account" /> }));
jest.mock('./components/profile/PrivacySettings', () => ({ PrivacySettings: () => <div data-testid="page-privacy" /> }));
jest.mock('./components/profile/BlockedUsersSettings', () => ({ BlockedUsersSettings: () => <div data-testid="page-blocked" /> }));
jest.mock('./components/DeleteDataSettings', () => ({ DeleteDataSettings: () => <div data-testid="page-delete" /> }));
jest.mock('./components/AISettings', () => ({ AISettings: () => mockReportingPage('page-llm-keys', '2 set') }));
jest.mock('./components/EmbeddingKeysSettings', () => ({ EmbeddingKeysSettings: () => <div data-testid="page-embedding-keys" /> }));
jest.mock('./components/VectorDBSettings', () => ({ VectorDBSettings: () => <div data-testid="page-vector-db" /> }));
jest.mock('./components/WebSearchToolSettings', () => ({ WebSearchToolSettings: () => <div data-testid="page-web-search" /> }));
jest.mock('./components/DefaultsSettings', () => ({ DefaultsSettings: () => <div data-testid="page-agents" /> }));
jest.mock('./components/LearnedFactsSettings', () => ({ LearnedFactsSettings: () => <div data-testid="page-memory" /> }));
jest.mock('./components/ChatIndexingSettings', () => ({ ChatIndexingSettings: () => <div data-testid="page-search-index" /> }));
jest.mock('./components/EmbeddingModelDefaults', () => ({ EmbeddingModelDefaults: () => <div data-testid="page-embedding-models" /> }));
jest.mock('./components/usage/LlmUsageSettings', () => ({ LlmUsageSettings: () => <div data-testid="page-usage-llm" /> }));
jest.mock('./components/usage/EmbeddingUsageSettings', () => ({ EmbeddingUsageSettings: () => <div data-testid="page-usage-embedding" /> }));
jest.mock('./components/usage/VectorDbUsageSettings', () => ({ VectorDbUsageSettings: () => <div data-testid="page-usage-vector-db" /> }));
jest.mock('./components/usage/WebSearchUsageSettings', () => ({ WebSearchUsageSettings: () => <div data-testid="page-usage-web-search" /> }));
jest.mock('./components/DeveloperSettings', () => ({ DeveloperSettings: () => mockReportingPage('page-developer', '2 API keys') }));
jest.mock('./components/ToolsSettings', () => ({ ToolsSettings: () => <div data-testid="page-tools" /> }));
jest.mock('./components/ConnectorsSettings', () => ({ ConnectorsSettings: () => <div data-testid="page-connectors" /> }));

function MockReportingPage({ testId, statusText }: { testId: string; statusText: string }) {
    const { setHeader, infoOpen } = useSettingsShell();
    useEffect(() => {
        setHeader({ statusText, hasKnowledge: true });
        return () => setHeader(null);
    }, [setHeader, statusText]);
    return <div data-testid={testId} data-info-open={String(infoOpen)} />;
}
const mockReportingPage = (testId: string, statusText: string) => <MockReportingPage testId={testId} statusText={statusText} />;

jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ logout: jest.fn() }) }));
jest.mock('../../hooks/useWindowSize', () => ({ useWindowSize: jest.fn(() => ({ width: 1280, height: 800 })) }));
const mockUseWindowSize = jest.requireMock('../../hooks/useWindowSize').useWindowSize;

const mockSetLeftSidebarExpanded = jest.fn();
jest.mock('../../context/LayoutContext', () => ({ useLayout: () => ({ setLeftSidebarExpanded: mockSetLeftSidebarExpanded }) }));

function CurrentPath() {
    return <span data-testid="current-path">{useLocation().pathname}</span>;
}

const renderAt = (path: string) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/settings/*" element={<><SettingsPage /><CurrentPath /></>} />
            </Routes>
        </MemoryRouter>
    );

describe('SettingsPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseWindowSize.mockReturnValue({ width: 1280, height: 800 });
    });

    test('desktop: navbar and menu, and /settings opens Profile › Account', () => {
        renderAt('/settings');

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-header')).not.toBeInTheDocument();
        expect(screen.getByTestId('page-account')).toBeInTheDocument();
        expect(screen.getByTestId('current-path')).toHaveTextContent('/settings/profile/account');
    });

    test.each([
        ['/settings/profile', '/settings/profile/account', 'page-account'],
        ['/settings/ai', '/settings/byok/llm-keys', 'page-llm-keys'],
        ['/settings/ai/llm-keys', '/settings/byok/llm-keys', 'page-llm-keys'],
        ['/settings/ai/embedding-keys', '/settings/byok/embedding-keys', 'page-embedding-keys'],
        ['/settings/ai/vector-db', '/settings/byok/vector-db', 'page-vector-db'],
        ['/settings/ai/defaults', '/settings/defaults/agents', 'page-agents'],
        ['/settings/actions', '/settings/defaults/agents', 'page-agents'],
        ['/settings/usage', '/settings/usage/llm-models', 'page-usage-llm'],
        ['/settings/nowhere', '/settings/profile/account', 'page-account'],
    ])('old link %s redirects to %s', (from, to, page) => {
        renderAt(from);

        expect(screen.getByTestId('current-path')).toHaveTextContent(to);
        expect(screen.getByTestId(page)).toBeInTheDocument();
    });

    test('Tools and Connectors keep their routes though they are not in the menu', () => {
        renderAt('/settings/tools');
        expect(screen.getByTestId('page-tools')).toBeInTheDocument();
    });

    test('clicking a menu page switches pages', () => {
        renderAt('/settings/profile/account');

        fireEvent.click(screen.getByTestId('settings-section-defaults'));

        expect(screen.getByTestId('page-agents')).toBeInTheDocument();
    });

    describe('phone', () => {
        beforeEach(() => {
            mockUseWindowSize.mockReturnValue({ width: 375, height: 812 });
        });

        test('the header names the page, its section and status', () => {
            renderAt('/settings/byok/llm-keys');

            expect(screen.queryByTestId('navbar')).not.toBeInTheDocument();
            expect(screen.getByTestId('mobile-header-title')).toHaveTextContent('LLM API Keys');
            expect(screen.getByTestId('mobile-header-subtitle')).toHaveTextContent('BYOK Settings · 2 set');
        });

        test('a page without a section shows "Settings" before its status', () => {
            renderAt('/settings/developer');

            expect(screen.getByTestId('mobile-header-title')).toHaveTextContent('Developer');
            expect(screen.getByTestId('mobile-header-subtitle')).toHaveTextContent('Settings · 2 API keys');
        });

        test('the i button opens the page knowledge; pages without knowledge have none', () => {
            const { unmount } = renderAt('/settings/byok/llm-keys');
            expect(screen.getByTestId('page-llm-keys')).toHaveAttribute('data-info-open', 'false');

            fireEvent.click(screen.getByTestId('settings-info-button'));

            expect(screen.getByTestId('page-llm-keys')).toHaveAttribute('data-info-open', 'true');
            unmount();

            renderAt('/settings/profile/account');
            expect(screen.queryByTestId('settings-info-button')).not.toBeInTheDocument();
        });

        test('the menu is the settings menu; picking a page closes it', () => {
            renderAt('/settings/profile/account');

            const menu = within(screen.getByTestId('mobile-header-menu-content'));
            fireEvent.click(menu.getByTestId('settings-section-byok'));
            fireEvent.click(menu.getByText('Vector DB Connection'));

            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false);
            expect(screen.getByTestId('page-vector-db')).toBeInTheDocument();
        });
    });
});
