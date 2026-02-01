import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import InstructionSidebarWidget from '../../../../../components/widgets/SidebarWidgets/InstructionSidebarWidget/InstructionSidebarWidget';
import { LayoutProvider } from '../../../../../context/LayoutContext';
import { AIProvider } from '../../../../../context/AIContext';
import { AuthProvider } from '../../../../../context/AuthContext';

// Mocks
jest.mock('../../../../../context/LayoutContext', () => ({
    useLayout: jest.fn(),
    LayoutProvider: ({ children }: any) => children
}));
import { useLayout } from '../../../../../context/LayoutContext';

jest.mock('../../../../../context/AIContext', () => ({
    useAI: () => ({ systemPrompt: 'Sys Prompt' }),
    AIProvider: ({ children }: any) => children
}));

jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
    AuthProvider: ({ children }: any) => children
}));

describe('InstructionSidebarWidget', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        // Setup default mock for useLayout
        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: true,
            setInstructionWidgetExpanded: jest.fn(),
            isInstructionWidgetExpanded: false
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('Renders correctly', () => {
        render(<InstructionSidebarWidget />);
        expect(screen.getByTestId('instruction-widget-toggle')).toBeInTheDocument();
        expect(screen.getByText('Instructions')).toBeInTheDocument();
    });

    test('Handles click to expand and scroll', () => {
        const setExpanded = jest.fn();
        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: true,
            setInstructionWidgetExpanded: setExpanded,
            isInstructionWidgetExpanded: false
        });

        const scrollIntoViewMock = jest.fn();
        jest.spyOn(document, 'getElementById').mockReturnValue({
            scrollIntoView: scrollIntoViewMock
        } as any);

        render(<InstructionSidebarWidget />);
        fireEvent.click(screen.getByTestId('instruction-widget-toggle'));

        expect(setExpanded).toHaveBeenCalledWith(true);

        // Fast-forward timers for scroll logic
        act(() => {
            jest.advanceTimersByTime(200);
        });

        expect(document.getElementById).toHaveBeenCalledWith('instruction-widget-scroll-anchor');
        expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    test('Handles click to expand but element missing (branch coverage)', () => {
        const setExpanded = jest.fn();
        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: true,
            setInstructionWidgetExpanded: setExpanded,
            isInstructionWidgetExpanded: false
        });

        jest.spyOn(document, 'getElementById').mockReturnValue(null);

        render(<InstructionSidebarWidget />);
        fireEvent.click(screen.getByTestId('instruction-widget-toggle'));

        act(() => {
            jest.advanceTimersByTime(200);
        });

        expect(document.getElementById).toHaveBeenCalledWith('instruction-widget-scroll-anchor');
        // No crash
    });

    test('Handles click to collapse (no scroll)', () => {
        const setExpanded = jest.fn();
        (useLayout as jest.Mock).mockReturnValue({
            isLeftSidebarExpanded: true,
            setInstructionWidgetExpanded: setExpanded,
            isInstructionWidgetExpanded: true // Already expanded
        });

        jest.spyOn(document, 'getElementById');

        render(<InstructionSidebarWidget />);
        fireEvent.click(screen.getByTestId('instruction-widget-toggle'));

        expect(setExpanded).toHaveBeenCalledWith(false); // Toggle to false

        act(() => {
            jest.advanceTimersByTime(200);
        });

        // Should NOT try to scroll
        expect(document.getElementById).not.toHaveBeenCalledWith('instruction-widget-scroll-anchor');
    });
});

// Coverage refresh
