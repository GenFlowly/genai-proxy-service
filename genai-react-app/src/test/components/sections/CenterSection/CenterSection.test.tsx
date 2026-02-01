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


});
