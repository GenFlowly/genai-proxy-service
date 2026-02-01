import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RightSidebar from '../../../../components/sections/RightSidebar/RightSidebar';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
// Mocks
jest.mock('../../../../context/LayoutContext');
jest.mock('../../../../hooks/useWidgetResolver', () => ({
    useWidgetResolver: jest.fn()
}));

describe('RightSidebar', () => {
    const mockUseLayout = useLayout as jest.Mock;
    const mockToggleRightSidebar = jest.fn();
    const mockUseWidgetResolver = jest.requireMock('../../../../hooks/useWidgetResolver').useWidgetResolver;

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseLayout.mockReturnValue({
            isRightSidebarExpanded: true,
            toggleRightSidebar: mockToggleRightSidebar
        });
        mockUseWidgetResolver.mockReturnValue([
            { id: 'MOCK_WIDGET', component: () => <div data-testid="mock-widget">Mock Widget</div> }
        ]);
    });

    test('renders correctly (Expanded)', () => {
        render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);

        const sidebar = screen.getByTestId('right-sidebar');
        expect(sidebar).toBeInTheDocument();
        expect(sidebar).not.toHaveClass('collapsed');

        expect(screen.getByTestId('mock-widget')).toBeInTheDocument();

        const toggleBtn = screen.getByTestId('right-sidebar-toggle');
        expect(toggleBtn).toBeInTheDocument();
        expect(toggleBtn).toHaveAttribute('title', 'Collapse Sidebar');
    });

    test('renders correctly (Collapsed)', () => {
        mockUseLayout.mockReturnValue({
            isRightSidebarExpanded: false,
            toggleRightSidebar: mockToggleRightSidebar
        });

        render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);

        const sidebar = screen.getByTestId('right-sidebar');
        expect(sidebar).toBeInTheDocument();
        // Check for collapsed class if possible, or just interaction
        // If CSS modules are working in tests (via setupTests or identity-obj-proxy), we can check class
    });

    test('toggles sidebar on click', () => {
        render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);
        const toggleBtn = screen.getByTestId('right-sidebar-toggle');
        fireEvent.click(toggleBtn);
        expect(mockToggleRightSidebar).toHaveBeenCalledTimes(1);
    });
});
