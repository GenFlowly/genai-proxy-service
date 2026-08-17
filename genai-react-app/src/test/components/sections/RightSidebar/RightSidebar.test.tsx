import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RightSidebar from '../../../../components/sections/RightSidebar/RightSidebar';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/LayoutContext');
jest.mock('../../../../hooks/useWidgetResolver', () => ({
    useWidgetResolver: jest.fn()
}));
jest.mock('../../../../hooks/useWindowSize', () => ({
    useWindowSize: jest.fn(() => ({ width: 1280, height: 800 }))
}));
const mockUseWindowSize = jest.requireMock('../../../../hooks/useWindowSize').useWindowSize;

describe('RightSidebar', () => {
    const mockUseLayout = useLayout as jest.Mock;
    const mockToggleRightSidebar = jest.fn();
    const mockUseWidgetResolver = jest.requireMock('../../../../hooks/useWidgetResolver').useWidgetResolver;

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseWindowSize.mockReturnValue({ width: 1280, height: 800 });
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

    describe('mobile view (full-screen modal)', () => {
        beforeEach(() => {
            mockUseWindowSize.mockReturnValue({ width: 375, height: 812 });
        });

        test('renders as a full-screen modal with the widgets when expanded', () => {
            render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);

            expect(screen.getByTestId('mobile-full-page-modal')).toBeInTheDocument();
            expect(screen.getByTestId('mock-widget')).toBeInTheDocument();
            // No title header and no desktop collapse button in the modal
            expect(screen.queryByText('AI Settings')).not.toBeInTheDocument();
            expect(screen.queryByTestId('right-sidebar-toggle')).not.toBeInTheDocument();
        });

        test('renders nothing when collapsed', () => {
            mockUseLayout.mockReturnValue({
                isRightSidebarExpanded: false,
                toggleRightSidebar: mockToggleRightSidebar
            });

            render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);

            expect(screen.queryByTestId('mobile-full-page-modal')).not.toBeInTheDocument();
            expect(screen.queryByTestId('mock-widget')).not.toBeInTheDocument();
        });

        test('Close Settings button at the bottom closes the modal', () => {
            render(<RightSidebar widgetIds={['MOCK_WIDGET']} />);

            const closeBtn = screen.getByTestId('mobile-full-page-modal-close');
            expect(closeBtn).toHaveTextContent('Close Settings');
            fireEvent.click(closeBtn);

            expect(mockToggleRightSidebar).toHaveBeenCalledTimes(1);
        });
    });
});
