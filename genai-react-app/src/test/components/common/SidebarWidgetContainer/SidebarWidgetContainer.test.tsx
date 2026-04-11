import React from 'react';
import { render, screen } from '@testing-library/react';
import SidebarWidgetContainer from '../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer';
import * as LayoutContext from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mock useLayout
jest.mock('../../../../context/LayoutContext', () => ({
    useLayout: jest.fn()
}));

describe('SidebarWidgetContainer Component', () => {
    const mockUseLayout = LayoutContext.useLayout as jest.Mock;

    const defaultProps = {
        children: <div>Expanded Content</div>,
        collapsedContent: <div>Collapsed Content</div>,
        header: <div>Expanded Header</div>,
        headerCollapsed: <div>Collapsed Header</div>,
        'data-testid': 'test-widget'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders expanded state correctly', () => {
        // Mock hook to return expanded state
        mockUseLayout.mockReturnValue({ isRightSidebarExpanded: true });

        render(<SidebarWidgetContainer {...defaultProps} />);

        const container = screen.getByTestId('test-widget');
        expect(container).toBeInTheDocument();
        expect(container).toHaveAttribute('data-collapsed', 'false');

        const header = screen.getByTestId('test-widget-header');
        expect(header).toHaveTextContent('Expanded Header');

        const content = screen.getByTestId('test-widget-content');
        expect(content).toHaveTextContent('Expanded Content');

        // Should not verify collapsed elements in standard way as they aren't rendered
        expect(screen.queryByTestId('test-widget-header-collapsed')).not.toBeInTheDocument();
        expect(screen.queryByTestId('test-widget-content-collapsed')).not.toBeInTheDocument();
    });

    test('renders collapsed state correctly', () => {
        // Mock hook to return collapsed state
        mockUseLayout.mockReturnValue({ isRightSidebarExpanded: false });

        render(<SidebarWidgetContainer {...defaultProps} />);

        const container = screen.getByTestId('test-widget');
        expect(container).toBeInTheDocument();
        expect(container).toHaveAttribute('data-collapsed', 'true');

        const collapsedHeader = screen.getByTestId('test-widget-header-collapsed');
        expect(collapsedHeader).toHaveTextContent('Collapsed Header');

        const collapsedContent = screen.getByTestId('test-widget-content-collapsed');
        expect(collapsedContent).toHaveTextContent('Collapsed Content');

        // Verify expanded elements are missing
        expect(screen.queryByTestId('test-widget-header')).not.toBeInTheDocument();
        expect(screen.queryByTestId('test-widget-content')).not.toBeInTheDocument();
    });

    test('renders without headers if not provided', () => {
        mockUseLayout.mockReturnValue({ isRightSidebarExpanded: true });

        render(
            <SidebarWidgetContainer
                children={<div>Content</div>}
                collapsedContent={<div>Collapsed</div>}
                data-testid="test-widget-no-header"
            />
        );

        expect(screen.queryByTestId('test-widget-no-header-header')).not.toBeInTheDocument();
        expect(screen.getByTestId('test-widget-no-header-content')).toHaveTextContent('Content');

        // Switch to collapsed
        mockUseLayout.mockReturnValue({ isRightSidebarExpanded: false });
        // Re-render required to pick up new hook value
        const { unmount } = render(
            <SidebarWidgetContainer
                children={<div>Content</div>}
                collapsedContent={<div>Collapsed</div>}
                data-testid="test-widget-no-header-2"
            />
        );

        expect(screen.queryByTestId('test-widget-no-header-2-header-collapsed')).not.toBeInTheDocument();
        expect(screen.getByTestId('test-widget-no-header-2-content-collapsed')).toHaveTextContent('Collapsed');
        unmount();
    });

    test('uses explicit isCollapsed prop over context state', () => {
        // Mock hook to return expanded state, but pass isCollapsed=true as prop
        mockUseLayout.mockReturnValue({ isRightSidebarExpanded: true });

        render(
            <SidebarWidgetContainer
                {...defaultProps}
                isCollapsed={true}
            />
        );

        const container = screen.getByTestId('test-widget');
        expect(container).toHaveAttribute('data-collapsed', 'true');
        expect(screen.getByTestId('test-widget-content-collapsed')).toBeInTheDocument();
    });
});

