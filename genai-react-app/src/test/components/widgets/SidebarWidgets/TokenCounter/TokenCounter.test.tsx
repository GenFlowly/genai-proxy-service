import React from 'react';
import { render, screen, act } from '@testing-library/react';
import TokenCounter from '../../../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');

jest.mock('../../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer', () =>
    ({ children, collapsedContent, 'data-testid': testId }: any) => (
        <div data-testid={testId}>
            <div data-testid="widget-collapsed-content">{collapsedContent}</div>
            <div data-testid="widget-content">{children}</div>
        </div>
    )
);

const draftBlock = {
    conversationBlockId: 'block-1',
    prompt: '',
    responseMessages: [],
    isLoading: false,
    status: 'draft' as const,
}

describe('TokenCounter', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Default Context — no active block, no prompt
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: '',
                activeBlockId: '',
                conversationBlockList: []
            }
        });

        // Fake timers for debouncing
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('renders with 0 tokens initially', () => {
        render(<TokenCounter />);

        // Wait for effect (debounced)
        act(() => {
            jest.advanceTimersByTime(600);
        });

        expect(screen.getByTestId('token-counter-widget')).toBeInTheDocument();
        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 0');
        expect(screen.getByTestId('token-count-collapsed')).toHaveTextContent('0');
    });

    test('estimates tokens when prompt is present', () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Hello World', // 11 chars → 3 tokens
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 3');
        expect(screen.getByTestId('token-count-collapsed')).toHaveTextContent('3');
    });

    test('does not count until the debounce elapses', () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Hello World',
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(300);
        });
        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 0');

        act(() => {
            jest.advanceTimersByTime(300);
        });
        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 3');
    });

    test('shows 0 tokens when active block is resolved', () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Some text',
                activeBlockId: 'block-1',
                conversationBlockList: [{
                    ...draftBlock,
                    status: 'resolved' as const,
                    isLoading: false
                }]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 0');
    });
});
