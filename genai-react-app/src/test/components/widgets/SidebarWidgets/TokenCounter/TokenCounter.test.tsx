import React from 'react';
import { render, screen, act } from '@testing-library/react';
import TokenCounter from '../../../../../components/widgets/SidebarWidgets/TokenCounter/TokenCounter';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');

// editorPrompt moved to the ConversationUI context (perf split); tests set
// this variable to control what the component reads from it
let mockEditorPrompt = '';
jest.mock('../../../../../context/ConversationContext', () => ({
    useConversationUI: () => ({ editorPrompt: mockEditorPrompt }),
}));

jest.mock('../../../../../hooks/useVendorDisplayNames', () => ({
    useVendorDisplayNames: () => (id: string) => ({ OPENAI: 'OpenAI', CLAUDE: 'Anthropic' } as Record<string, string>)[id] ?? id,
}));

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
        mockEditorPrompt = '';
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
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
        expect(screen.getByRole('heading', { name: 'Tokens' })).toBeInTheDocument();
        expect(screen.getByTestId('token-count-display')).toHaveTextContent(/^0$/);
        expect(screen.getByTestId('token-usage-empty')).toHaveTextContent('No replies yet');
    });

    test('estimates tokens when prompt is present', () => {
        mockEditorPrompt = 'Hello World'; // 11 chars → 3 tokens
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        expect(screen.getByTestId('token-count-display')).toHaveTextContent(/^3$/);
    });

    test('does not count until the debounce elapses', () => {
        mockEditorPrompt = 'Hello World';
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                activeBlockId: 'block-1',
                conversationBlockList: [draftBlock]
            }
        });

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(300);
        });
        expect(screen.getByTestId('token-count-display')).toHaveTextContent(/^0$/);

        act(() => {
            jest.advanceTimersByTime(300);
        });
        expect(screen.getByTestId('token-count-display')).toHaveTextContent(/^3$/);
    });

    test('shows 0 tokens when active block is resolved', () => {
        mockEditorPrompt = 'Some text';
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
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

        expect(screen.getByTestId('token-count-display')).toHaveTextContent(/^0$/);
    });

    test('lists each vendor\'s usage in this conversation, cached tokens and cost included', () => {
        const message = (id: string, aiVendor: string, usage: Record<string, number | null>) => ({
            messageId: id, text: 'answer', aiVendor, isLoading: false, ...usage,
        })
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                activeBlockId: '',
                conversationBlockList: [
                    { ...draftBlock, conversationBlockId: 'b1', status: 'resolved', responseMessages: [
                        message('m1', 'OPENAI', { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, tokensReadFromCache: 0, costUsd: 0.0012 }),
                        message('m2', 'CLAUDE', { inputTokens: 900, outputTokens: 200, totalTokens: 1100, tokensReadFromCache: 512, costUsd: 1.5 }),
                    ] },
                    { ...draftBlock, conversationBlockId: 'b2', status: 'resolved', responseMessages: [
                        message('m3', 'OPENAI', { inputTokens: 1800, outputTokens: 400, totalTokens: 2200, tokensReadFromCache: 1024, costUsd: 0.002 }),
                    ] },
                ],
            },
        });

        render(<TokenCounter />);

        const openai = screen.getByTestId('token-usage-OPENAI');
        expect(openai).toHaveTextContent('OpenAI');
        expect(openai).toHaveTextContent('$0.0032');
        expect(openai).toHaveTextContent('3,000');
        expect(openai).toHaveTextContent('700');
        expect(openai).toHaveTextContent('1,024');
        expect(openai).toHaveTextContent('3,700');

        const claude = screen.getByTestId('token-usage-CLAUDE');
        expect(claude).toHaveTextContent('Anthropic');
        expect(claude).toHaveTextContent('$1.50');
        expect(claude).toHaveTextContent('512');
        expect(screen.queryByTestId('token-usage-empty')).not.toBeInTheDocument();
    });
});
