import React from 'react';
import { render, screen } from '@testing-library/react';
import MemoryPage from '../../pages/MemoryPage/MemoryPage';

// Mock children
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/LeftSidebar/LeftSidebar', () => ({ widgetIds }: any) => <div data-testid="left-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>LeftSidebar</div>);
jest.mock('../../components/sections/RightSidebar/RightSidebar', () => ({ widgetIds }: any) => <div data-testid="right-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>RightSidebar</div>);
jest.mock('../../components/sections/CenterSection/CenterSection', () => ({ widgetIds }: any) => <div data-testid="center-section" data-widget-ids={JSON.stringify(widgetIds)}>CenterSection</div>);

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

    beforeEach(() => {
        jest.clearAllMocks();
        getPageConfig.mockReturnValue({
            pageId: 'MEMORY_PAGE',
            leftSidebar: ['MOCK_LEFT'],
            rightSidebar: ['MOCK_RIGHT'],
            centerSection: ['MOCK_CENTER']
        });
        useLayout.mockReturnValue({
            setRightSidebarExpanded: mockSetRightSidebarExpanded
        });
    });

    test('renders layout with correct configuration', () => {
        render(
            <MemoryRouter>
                <MemoryPage />
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();

        const left = screen.getByTestId('left-sidebar');
        expect(left).toBeInTheDocument();
        expect(left).toHaveAttribute('data-widget-ids', '["MOCK_LEFT"]');

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
});
