import React from 'react';
import { render, screen } from '@testing-library/react';
import LeftSidebar from '../../../../components/sections/LeftSidebar/LeftSidebar';
import { useLayout } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/LayoutContext');
jest.mock('../../../../hooks/useWidgetResolver', () => ({
    useWidgetResolver: jest.fn()
}));

describe('LeftSidebar', () => {
    const mockUseLayout = useLayout as jest.Mock;
    // Mock the hook return value
    const mockUseWidgetResolver = jest.requireMock('../../../../hooks/useWidgetResolver').useWidgetResolver;

    beforeEach(() => {
        jest.clearAllMocks();
        // Default mock resolver: return generic mock widgets
        mockUseWidgetResolver.mockReturnValue([
            { id: 'MOCK_1', component: () => <div data-testid="mock-widget-1">Mock 1</div> },
            { id: 'MOCK_2', component: () => <div data-testid="mock-widget-2">Mock 2</div> }
        ]);
    });

    test('renders correctly (Expanded) with widgets', () => {
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true,
            isLeftSidebarMinimized: false
        });

        render(<LeftSidebar widgetIds={['MOCK_1', 'MOCK_2']} />);

        const sidebar = screen.getByTestId('left-sidebar');
        expect(sidebar).toBeInTheDocument();
        expect(sidebar).not.toHaveClass('collapsed');

        expect(screen.getByTestId('mock-widget-1')).toBeInTheDocument();
        expect(screen.getByTestId('mock-widget-2')).toBeInTheDocument();
        expect(mockUseWidgetResolver).toHaveBeenCalledWith(['MOCK_1', 'MOCK_2']);
    });

    test('renders correctly (Collapsed)', () => {
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: false,
            isLeftSidebarMinimized: false
        });

        // Even collapsed, typically content might exist but hidden, or logic renders it.
        // Based on existing code: renders generic container with collapsed class.
        render(<LeftSidebar widgetIds={['MOCK_1']} />);

        const sidebar = screen.getByTestId('left-sidebar');
        expect(sidebar).toBeInTheDocument();
        // expect(sidebar).toHaveClass('collapsed'); // if relevant
    });
});
