import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RightSidebar from '../../../../components/sections/RightSidebar/RightSidebar';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/LayoutContext');
jest.mock('../../../../components/widgets/SidebarWidgets/NewChatWidget/NewChatWidget', () => () => <div data-testid="new-chat-widget-mock">NewChatWidget</div>);
jest.mock('../../../../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget', () => () => <div data-testid="ai-vendor-widget-mock">AIVendorWidget</div>);
jest.mock('../../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter', () => () => <div data-testid="token-counter-mock">TokenCounter</div>);

describe('RightSidebar', () => {
    const mockUseLayout = useLayout as jest.Mock;
    const mockToggleRightSidebar = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseLayout.mockReturnValue({
            isRightSidebarExpanded: true,
            toggleRightSidebar: mockToggleRightSidebar
        });
    });

    test('renders correctly (Expanded)', () => {
        render(<RightSidebar />);

        const sidebar = screen.getByTestId('right-sidebar');
        expect(sidebar).toBeInTheDocument();
        expect(sidebar).not.toHaveClass('collapsed');

        expect(screen.getByTestId('new-chat-widget-mock')).toBeInTheDocument();
        expect(screen.getByTestId('ai-vendor-widget-mock')).toBeInTheDocument();
        expect(screen.getByTestId('token-counter-mock')).toBeInTheDocument();

        const toggleBtn = screen.getByTestId('right-sidebar-toggle');
        expect(toggleBtn).toBeInTheDocument();
        expect(toggleBtn).toHaveAttribute('title', 'Collapse Sidebar');
    });

    test('renders correctly (Collapsed)', () => {
        mockUseLayout.mockReturnValue({
            isRightSidebarExpanded: false,
            toggleRightSidebar: mockToggleRightSidebar
        });

        render(<RightSidebar />);

        const sidebar = screen.getByTestId('right-sidebar');
        expect(sidebar).toBeInTheDocument();
        // Check for collapsed class if possible, or just interaction
        // If CSS modules are working in tests (via setupTests or identity-obj-proxy), we can check class
    });

    test('toggles sidebar on click', () => {
        render(<RightSidebar />);
        const toggleBtn = screen.getByTestId('right-sidebar-toggle');
        fireEvent.click(toggleBtn);
        expect(mockToggleRightSidebar).toHaveBeenCalledTimes(1);
    });
});
