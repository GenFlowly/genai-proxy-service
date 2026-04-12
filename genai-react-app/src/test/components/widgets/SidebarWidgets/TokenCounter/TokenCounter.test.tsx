import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import TokenCounter from '../../../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import { countTokens } from '../../../../../utils/tokenizer';
import { AIVendor } from '../../../../../constants/vendors';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');
jest.mock('../../../../../utils/tokenizer');

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
    const mockCountTokens = countTokens as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Default Context — no active block, no prompt
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: '',
                activeBlockId: '',
                conversationBlockList: []
            },
            ai: {
                config: []
            }
        });

        // Mock tokenizer
        mockCountTokens.mockResolvedValue(0);

        // Fake timers for debouncing
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('renders with 0 tokens initially', async () => {
        render(<TokenCounter />);

        // Wait for effect (debounced)
        act(() => {
            jest.advanceTimersByTime(600);
        });

        expect(screen.getByTestId('token-counter-widget')).toBeInTheDocument();
        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 0');
        expect(screen.getByTestId('token-count-collapsed')).toHaveTextContent('0');
    });

    test('counts tokens when prompt is present', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Hello World',
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            },
            ai: {
                config: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
            }
        });
        mockCountTokens.mockResolvedValue(2);

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 2');
        });

        expect(mockCountTokens).toHaveBeenCalledWith('Hello World', 'gpt-4');
    });

    test('counts only prompt text, not supplemental text', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Prompt',
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            },
            ai: {
                config: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
            }
        });
        mockCountTokens.mockResolvedValue(1);

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Counting tokens…');
        });

        expect(mockCountTokens).toHaveBeenCalledWith('Prompt', 'gpt-4');
    });

    test('uses fallback model if no config found', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Test',
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            },
            ai: {
                config: []
            }
        });
        mockCountTokens.mockResolvedValue(1);

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        await waitFor(() => {
            expect(mockCountTokens).toHaveBeenCalledWith('Test', 'gpt-4o');
        });
    });

    test('shows 0 tokens when active block is resolved', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Some text',
                activeBlockId: 'block-1',
                conversationBlockList: [{
                    ...draftBlock,
                    status: 'resolved' as const,
                    isLoading: false
                }]
            },
            ai: {
                config: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 0');
        });

        expect(mockCountTokens).not.toHaveBeenCalled();
    });

    test('shows loading state', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Loading...',
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            },
            ai: { config: [] }
        });

        let resolveCount: (value: number) => void;
        mockCountTokens.mockImplementation(() => new Promise(resolve => {
            resolveCount = resolve;
        }));

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(500);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Counting tokens…');
        });

        act(() => {
            resolveCount!(10);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Estimated: 10');
        });
    });
});
