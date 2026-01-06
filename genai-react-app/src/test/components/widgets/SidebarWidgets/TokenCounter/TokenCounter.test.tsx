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

describe('TokenCounter', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;
    const mockCountTokens = countTokens as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Default Context
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: ''
            },
            ai: {
                supplementalText: '',
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
        expect(screen.getByTestId('token-count-display')).toHaveTextContent('Tokens: 0');
        expect(screen.getByTestId('token-count-collapsed')).toHaveTextContent('0');
    });

    test('counts tokens when prompt is present', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Hello World'
            },
            ai: {
                supplementalText: '',
                config: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
            }
        });
        mockCountTokens.mockResolvedValue(2); // Mocked result

        render(<TokenCounter />);

        // Advance debounce
        act(() => {
            jest.advanceTimersByTime(600);
        });

        // Wait for async update
        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Tokens: 2');
        });

        expect(mockCountTokens).toHaveBeenCalledWith('Hello World', 'gpt-4');
    });

    test('counts tokens combining prompt and supplemental text', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Prompt'
            },
            ai: {
                supplementalText: 'Context',
                config: [{ aiVendor: AIVendor.OPENAI, model: 'gpt-4' }]
            }
        });
        mockCountTokens.mockResolvedValue(5);

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Tokens: 5');
        });

        expect(mockCountTokens).toHaveBeenCalledWith('PromptContext', 'gpt-4');
    });

    test('uses fallback model if no config found', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                editorPrompt: 'Test'
            },
            ai: {
                supplementalText: '',
                config: [] // No openai config
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

    test('shows loading state', async () => {
        mockUseSidebarWidget.mockReturnValue({
            conversation: { editorPrompt: 'Loading...' },
            ai: { supplementalText: '', config: [] }
        });

        // Delay resolution
        mockCountTokens.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(10), 100)));

        render(<TokenCounter />);

        act(() => {
            jest.advanceTimersByTime(600); // Trigger calculation start
        });

        // Should be loading now
        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Counting tokens…');
        });

        // Resolve
        act(() => {
            jest.advanceTimersByTime(200);
        });

        await waitFor(() => {
            expect(screen.getByTestId('token-count-display')).toHaveTextContent('Tokens: 10');
        });
    });
});
