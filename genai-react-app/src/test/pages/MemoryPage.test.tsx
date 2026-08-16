import React from 'react';
import { render, screen } from '@testing-library/react';
import MemoryPage from '../../pages/MemoryPage/MemoryPage';

// Mock children
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/RightSidebar/RightSidebar', () => ({ widgetIds }: any) => <div data-testid="right-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>RightSidebar</div>);
jest.mock('../../components/sections/CenterSection/CenterSection', () => ({ widgetIds }: any) => <div data-testid="center-section" data-widget-ids={JSON.stringify(widgetIds)}>CenterSection</div>);
jest.mock('../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget', () => () => <div data-testid="saved-notes-widget">SavedNotesWidget</div>);

// Mock Config
jest.mock('../../config/PageWidgetConfig', () => ({
    getPageConfig: jest.fn()
}));
const { getPageConfig } = require('../../config/PageWidgetConfig');

// Mock LayoutContext
jest.mock('../../context/LayoutContext', () => ({
    useLayout: jest.fn()
}));
const { useLayout } = require('../../context/LayoutContext');

import { MemoryRouter } from 'react-router-dom';

describe('MemoryPage', () => {
    const mockSetRightSidebarExpanded = jest.fn();
    const mockSetLeftSidebarExpanded = jest.fn();
    const mockSetLeftSidebarMinimized = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        getPageConfig.mockReturnValue({
            pageId: 'MEMORY_PAGE',
            leftSidebar: [],
            rightSidebar: ['MOCK_RIGHT'],
            centerSection: ['MOCK_CENTER']
        });
        useLayout.mockReturnValue({
            setRightSidebarExpanded: mockSetRightSidebarExpanded,
            setLeftSidebarExpanded: mockSetLeftSidebarExpanded,
            setLeftSidebarMinimized: mockSetLeftSidebarMinimized
        });
    });

    test('renders layout with correct configuration', () => {
        render(
            <MemoryRouter>
                <MemoryPage />
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();

        // Saved notes render in a resizable side panel (desktop)
        expect(screen.getByTestId('saved-notes-sidebar')).toBeInTheDocument();
        expect(screen.getByTestId('saved-notes-widget')).toBeInTheDocument();
        expect(screen.getByTestId('saved-notes-resize-handle')).toBeInTheDocument();

        const center = screen.getByTestId('center-section');
        expect(center).toBeInTheDocument();
        expect(center).toHaveAttribute('data-widget-ids', '["MOCK_CENTER"]');

        const right = screen.getByTestId('right-sidebar');
        expect(right).toBeInTheDocument();
        expect(right).toHaveAttribute('data-widget-ids', '["MOCK_RIGHT"]');
    });

    test('collapses right sidebar on mount', () => {
        render(
            <MemoryRouter>
                <MemoryPage />
            </MemoryRouter>
        );

        expect(mockSetRightSidebarExpanded).toHaveBeenCalledWith(false);
        expect(mockSetRightSidebarExpanded).toHaveBeenCalledTimes(1);
    });

    test('expands left sidebar on mount', () => {
        render(
            <MemoryRouter>
                <MemoryPage />
            </MemoryRouter>
        );

        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledWith(true);
        expect(mockSetLeftSidebarExpanded).toHaveBeenCalledTimes(1);
    });

    test('un-minimizes left sidebar on mount so it is visible after arriving from chat', () => {
        render(
            <MemoryRouter>
                <MemoryPage />
            </MemoryRouter>
        );

        expect(mockSetLeftSidebarMinimized).toHaveBeenCalledWith(false);
        expect(mockSetLeftSidebarMinimized).toHaveBeenCalledTimes(1);
    });
});
