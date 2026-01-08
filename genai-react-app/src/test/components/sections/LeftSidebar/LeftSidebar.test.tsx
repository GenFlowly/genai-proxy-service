import React from 'react';
import { render, screen } from '@testing-library/react';
import LeftSidebar from '../../../../components/sections/LeftSidebar/LeftSidebar';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/LayoutContext');
jest.mock('../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadWidget', () => () => <div data-testid="thread-widget-mock">ThreadWidget</div>);
jest.mock('../../../../components/widgets/SidebarWidgets/InstructionSidebarWidget/InstructionSidebarWidget', () => () => <div data-testid="instruction-sidebar-widget-mock">InstructionSidebarWidget</div>);

describe('LeftSidebar', () => {
    const mockUseLayout = useLayout as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders correctly (Expanded)', () => {
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        render(<LeftSidebar />);

        const sidebar = screen.getByTestId('left-sidebar');
        expect(sidebar).toBeInTheDocument();
        expect(sidebar).not.toHaveClass('collapsed'); // Assuming module class name mapping happens, but checking presence/absence logic mainly

        expect(screen.getByTestId('instruction-sidebar-widget-mock')).toBeInTheDocument();
        expect(screen.getByTestId('thread-widget-mock')).toBeInTheDocument();
    });

    test('renders correctly (Collapsed)', () => {
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: false
        });

        render(<LeftSidebar />);

        const sidebar = screen.getByTestId('left-sidebar');
        expect(sidebar).toBeInTheDocument();
    });
});
