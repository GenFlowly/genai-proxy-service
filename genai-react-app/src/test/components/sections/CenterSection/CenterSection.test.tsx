import React from 'react';
import { render, screen } from '@testing-library/react';
import CenterSection from '../../../../components/sections/CenterSection/CenterSection';
import { LayoutProvider } from '../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/ConversationContext'); // Might not be needed if not used directly
jest.mock('../../../../hooks/useWidgetResolver', () => ({
    useWidgetResolver: jest.fn()
}));
// Helper
const mockUseWidgetResolver = jest.requireMock('../../../../hooks/useWidgetResolver').useWidgetResolver;

jest.mock('../../../../context/LayoutContext', () => ({
    ...jest.requireActual('../../../../context/LayoutContext'),
    useLayout: jest.fn(),
    LayoutProvider: ({ children }: any) => <div>{children}</div>
}));
const mockUseLayout = jest.requireMock('../../../../context/LayoutContext').useLayout;

describe('CenterSection', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseWidgetResolver.mockReturnValue([]);
        mockUseLayout.mockReturnValue({ isInstructionWidgetExpanded: false });
    });

    test('renders correctly with resolved widgets', () => {
        mockUseWidgetResolver.mockReturnValue([
            { id: 'WIDGET_A', component: () => <div data-testid="widget-a">Widget A</div> },
            { id: 'WIDGET_B', component: () => <div data-testid="widget-b">Widget B</div> }
        ]);

        render(
            <CenterSection widgetIds={['WIDGET_A', 'WIDGET_B']} />
        );

        expect(screen.getByTestId('center-section')).toBeInTheDocument();
        expect(screen.getByTestId('center-section-content')).toBeInTheDocument();

        expect(screen.getByTestId('widget-a')).toBeInTheDocument();
        expect(screen.getByTestId('widget-b')).toBeInTheDocument();
        expect(mockUseWidgetResolver).toHaveBeenCalledWith(['WIDGET_A', 'WIDGET_B']);
    });

    test('renders sticky scroll anchor when instruction widget is NOT expanded', () => {
        mockUseLayout.mockReturnValue({ isInstructionWidgetExpanded: false });

        const { container } = render(
            <CenterSection widgetIds={[]} />
        );

        // Access via ID as it's static
        // element id="instruction-widget-scroll-anchor"
        const anchor = container.querySelector('#instruction-widget-scroll-anchor');
        expect(anchor).toHaveStyle({
            position: 'sticky',
            top: '0',
            backgroundColor: 'var(--color-sidebar-background)'
        });
    });

    test('renders non-sticky scroll anchor when instruction widget IS expanded', () => {
        mockUseLayout.mockReturnValue({ isInstructionWidgetExpanded: true });

        const { container } = render(
            <CenterSection widgetIds={[]} />
        );

        const anchor = container.querySelector('#instruction-widget-scroll-anchor');
        // When expanded, styles should be undefined (not present in jsdom style usually, or check specifically)
        // Check strict style
        expect(anchor).not.toHaveStyle({ position: 'sticky' });
    });
});
