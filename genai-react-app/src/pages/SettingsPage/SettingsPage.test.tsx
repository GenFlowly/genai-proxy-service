import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from './SettingsPage';
import { useLayout } from '../../context/LayoutContext';

// Mocks
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/LeftSidebar/LeftSidebar', () => ({ widgetIds }: any) => (
    <div data-testid="left-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>LeftSidebar</div>
));
jest.mock('../../components/sections/CenterSection/CenterSection', () => ({ widgetIds }: any) => (
    <div data-testid="center-section" data-widget-ids={JSON.stringify(widgetIds)}>CenterSection</div>
));

jest.mock('../../context/LayoutContext', () => ({
    useLayout: jest.fn()
}));

const mockGetPageConfig = jest.requireMock('../../config/PageWidgetConfig').getPageConfig;

describe('SettingsPage', () => {
    const mockSetLeftSidebarExpanded = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (useLayout as jest.Mock).mockReturnValue({
            setLeftSidebarExpanded: mockSetLeftSidebarExpanded
        });
        mockGetPageConfig.mockReturnValue({
            pageId: 'SETTINGS_PAGE',
            leftSidebar: ['SIDEBAR_MENU'],
            centerSection: ['VENDOR_WIDGET', 'DB_WIDGET'],
            rightSidebar: []
        });
    });


    test('renders correctly and initializes layout', () => {
        render(
            <MemoryRouter>
                <SettingsPage />
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByTestId('left-sidebar')).toHaveAttribute('data-widget-ids', '["SIDEBAR_MENU"]');
        expect(screen.getByTestId('center-section')).toHaveAttribute('data-widget-ids', '["PROFILE_SETTINGS","CONFIGURE_AI_VENDOR_SETTINGS","DATABASE_CONNECTIONS_SETTINGS"]');

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true);
    });

});
