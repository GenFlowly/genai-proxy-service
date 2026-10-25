import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SettingsPage from './SettingsPage';

// Mocks
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('./components/ProfileSettings', () => ({ ProfileSettings: () => <div data-testid="profile-settings">Profile Settings</div> }));
jest.mock('./components/AISettings', () => ({ AISettings: () => <div data-testid="ai-settings">AI Settings</div> }));

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

        test('/settings shows the settings menu as a full page instead of redirecting', () => {
            render(
                <MemoryRouter initialEntries={['/settings']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            // Menu page is shown, not a settings section
            expect(screen.getByText('Profile')).toBeInTheDocument();
            expect(screen.getByText('AI Settings')).toBeInTheDocument();
            expect(screen.getByText('Defaults')).toBeInTheDocument();
            expect(screen.queryByTestId('profile-settings')).not.toBeInTheDocument();

            // Breadcrumbs: Menu > Settings
            expect(screen.getByTestId('breadcrumb-Menu')).toBeInTheDocument();
            expect(screen.getByTestId('breadcrumb-Settings')).toBeInTheDocument();
        });

        test('tapping a parent section expands its submenu in place, then a child opens that section full page', () => {
            render(
                <MemoryRouter initialEntries={['/settings']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            // Tapping the parent expands its submenu without leaving the menu page:
            // the child links appear and no section content is shown yet
            fireEvent.click(screen.getByText('AI Settings'));
            expect(screen.getByText('LLM API Keys')).toBeInTheDocument();
            expect(screen.queryByTestId('ai-settings')).not.toBeInTheDocument();
            expect(screen.getByText('Defaults')).toBeInTheDocument();

            // Tapping a child opens that section full page: no sidebar menu items around it
            fireEvent.click(screen.getByText('LLM API Keys'));
            expect(screen.getByTestId('ai-settings')).toBeInTheDocument();
            expect(screen.queryByText('Defaults')).not.toBeInTheDocument();
        });

        test('section routes render without the sidebar on mobile', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.getByTestId('profile-settings')).toBeInTheDocument();
            expect(screen.queryByText('AI Settings')).not.toBeInTheDocument();
        });

        test('section route shows Menu > Settings > Section breadcrumbs', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.getByTestId('breadcrumb-Menu')).toBeInTheDocument();
            expect(screen.getByTestId('breadcrumb-Settings')).toBeInTheDocument();
            expect(screen.getByTestId('breadcrumb-Profile')).toBeInTheDocument();
            expect(screen.getByTestId('breadcrumb-Profile')).toHaveAttribute('aria-current', 'page');
        });

        test('Settings breadcrumb navigates back to the settings menu page', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            fireEvent.click(screen.getByTestId('breadcrumb-Settings'));

            expect(screen.queryByTestId('profile-settings')).not.toBeInTheDocument();
            expect(screen.getByText('AI Settings')).toBeInTheDocument(); // Menu page items
        });

        test('Menu breadcrumb opens the mobile menu', () => {
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            fireEvent.click(screen.getByTestId('breadcrumb-Menu'));

            expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true);
        });

        test('breadcrumbs are not rendered on desktop', () => {
            mockUseWindowSize.mockReturnValue({ width: 1280, height: 800 });
            render(
                <MemoryRouter initialEntries={['/settings/profile']}>
                    <Routes>
                        <Route path="/settings/*" element={<SettingsPage />} />
                    </Routes>
                </MemoryRouter>
            );

            expect(screen.queryByTestId('breadcrumbs')).not.toBeInTheDocument();
        });
    });
});
