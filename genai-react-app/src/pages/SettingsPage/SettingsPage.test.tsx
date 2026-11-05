import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SettingsPage from './SettingsPage';

// Mocks
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('./components/ProfileSettings', () => ({ ProfileSettings: () => <div data-testid="profile-settings">Profile Settings</div> }));
jest.mock('./components/AISettings', () => ({ AISettings: () => <div data-testid="ai-settings">AI Settings</div> }));
// The real MobileHeader drives the hamburger overlay via LayoutContext, which
// is already covered by MobileHeader's own test suite. Here we only care
// that SettingsPage wires the right title/menuContent into it.
jest.mock('../../components/widgets/MobileHeader/MobileHeader', () => ({
    __esModule: true,
    default: ({ title, menuContent }: any) => (
        <div data-testid="mobile-header">
            <span data-testid="mobile-header-title">{title}</span>
            <div data-testid="mobile-header-menu-content">{menuContent}</div>
        </div>
    ),
}));

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        logout: jest.fn()
    })
}));

jest.mock('../../hooks/useWindowSize', () => ({
    useWindowSize: jest.fn(() => ({ width: 1280, height: 800 }))
}));
const mockUseWindowSize = jest.requireMock('../../hooks/useWindowSize').useWindowSize;

const mockSetLeftSidebarExpanded = jest.fn();
jest.mock('../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
    })
}));

describe('SettingsPage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseWindowSize.mockReturnValue({ width: 1280, height: 800 });
    });

    test('renders correctly and defaults to profile tab', () => {
        render(
            <MemoryRouter initialEntries={['/settings']}>
                <Routes>
                    <Route path="/settings/*" element={<SettingsPage />} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.queryByTestId('mobile-header')).not.toBeInTheDocument();
        expect(screen.getByText('Settings')).toBeInTheDocument(); // Sidebar header
        expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('ai-settings')).not.toBeInTheDocument();
    });

    test('switches tabs correctly', () => {
        render(
            <MemoryRouter initialEntries={['/settings/profile']}>
                <Routes>
                    <Route path="/settings/*" element={<SettingsPage />} />
                </Routes>
            </MemoryRouter>
        );

        // Click AI Settings tab
        fireEvent.click(screen.getByText('AI Settings'));
        expect(screen.getByTestId('ai-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-settings')).not.toBeInTheDocument();

        // Back to Profile
        fireEvent.click(screen.getByText('Profile'));
        expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
        expect(screen.queryByTestId('ai-settings')).not.toBeInTheDocument();
    });

    describe('mobile view', () => {
        beforeEach(() => {
            mockUseWindowSize.mockReturnValue({ width: 375, height: 812 });
        });

        test('shows MobileHeader instead of Navbar, titled after the active section', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.queryByTestId('navbar')).not.toBeInTheDocument();
            expect(screen.getByTestId('mobile-header-title')).toHaveTextContent('Profile');
            expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
        });

        test('/settings redirects straight to the profile section, same as desktop', () => {
            render(
                <MemoryRouter initialEntries={['/settings']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
        });

        test('title reflects a nested AI sub-page', () => {
            render(
                <MemoryRouter initialEntries={['/settings/ai/llm-keys']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.getByTestId('mobile-header-title')).toHaveTextContent('LLM API Keys');
            expect(screen.getByTestId('ai-settings')).toBeInTheDocument();
        });

        test('the mobile menu content is the settings sidebar; navigating closes it', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            const menu = within(screen.getByTestId('mobile-header-menu-content'));
            expect(menu.getByText('Profile')).toBeInTheDocument();
            expect(menu.getByText('AI Settings')).toBeInTheDocument();

            fireEvent.click(menu.getByText('Profile'));

            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(false);
        });
    });
});
