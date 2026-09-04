import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Response from '../../../../../components/widgets/ConversationWidget/ResponseWidget/Response';
import { useConversation } from '../../../../../context/ConversationContext';
import { useLayout } from '../../../../../context/LayoutContext';
import { AIVendor } from '../../../../../constants/vendors';
import '@testing-library/jest-dom';

// Mock contexts
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/LayoutContext');

// The learned-facts stat polls via useAuth + the learned-facts service —
// stub both so tests control the poll results
jest.mock('../../../../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('tok') })
}));
jest.mock('../../../../../services/learnedFactsService');
const { getLearnedFacts, deleteMemoryFact } = require('../../../../../services/learnedFactsService');

// JSDOM's window is 1024px wide, which would cap rendering to 1 vendor.
// Mock the responsive hook so vendor count is deterministic and adjustable.
let mockMaxVendors = 3;
jest.mock('../../../../../hooks/useMaxVendors', () => ({
    useMaxVendors: () => mockMaxVendors
}));

// Mock child components
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextContainer: (props) => {
        const { children, title, content, subheader, 'data-testid': testId } = props;
        return (
            <div data-testid={testId || 'text-container'}>
                <div data-testid="tc-title">{title}</div>
                {subheader}
                <div data-testid="tc-content">{content}</div>
                {children}
            </div>
        );
    },
    RectangleButton: (props) => {
        const { label, onClick, disabled, 'data-testid': testId } = props;
        return (
            <button data-testid={testId} onClick={onClick} disabled={disabled}>
                {label}
            </button>
        );
    },
}));

jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    OpenAIBrandName: () => <span>OpenAI</span>,
    ClaudeBrandName: () => <span>Claude</span>,
    GeminiBrandName: () => <span>Gemini</span>
}));

describe('Response Widget Component', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseLayout = useLayout as jest.Mock;
    const mockSetSelectedResponseForBlock = jest.fn();
    const mockGetSelectedResponseForBlock = jest.fn();
    const mockSetVendorSelectionForBlock = jest.fn();
    let mockSelection: string[] = [];

    beforeEach(() => {
        jest.clearAllMocks();
        mockSelection = [];
        mockMaxVendors = 3;
        mockUseConversation.mockReturnValue({
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            getVendorSelectionForBlock: () => mockSelection,
            setVendorSelectionForBlock: mockSetVendorSelectionForBlock,
            generateResponsesStream: jest.fn(),
            stopGenerating: jest.fn()
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true,
            isRightSidebarExpanded: true
        });
        mockGetSelectedResponseForBlock.mockReturnValue(null);
    });

    const mockMessages = [
        { messageId: 'msg-1', text: 'Response 1', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0 },
        { messageId: 'msg-2', text: 'Response 2', aiVendor: AIVendor.CLAUDE, isLoading: false, timestamp: 0 }
    ];

    test('renders nothing if no messages', () => {
        render(<Response blockId="block-1" responseMessages={[]} />);
        expect(screen.queryByTestId('text-container')).not.toBeInTheDocument();
    });

    test('renders messages', () => {
        render(<Response blockId="block-1" responseMessages={mockMessages} data-testid="res-comp" />);
        expect(screen.getByTestId('res-comp')).toBeInTheDocument();
        expect(screen.getAllByTestId('response-message')).toHaveLength(2);
        // Toggle group label + BrandName title = 2
        expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Claude').length).toBeGreaterThanOrEqual(1);
    });

    test('handles Follow Up click', () => {
        const onFollowUp = jest.fn();
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={onFollowUp} />);

        const followUpBtns = screen.getAllByTestId('follow-up-button');
        expect(followUpBtns).toHaveLength(2); // Should show for all responses
        fireEvent.click(followUpBtns[1]); // Click the second one (msg-2)

        expect(mockSetSelectedResponseForBlock).toHaveBeenCalledWith('block-1', 'msg-2');
        expect(onFollowUp).toHaveBeenCalledWith('msg-2');
    });

    test('Follow Up button disabled if props.disabled is true', () => {
        const onFollowUp = jest.fn();
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={onFollowUp} disabled={true} />);

        const followUpBtns = screen.getAllByTestId('follow-up-button');
        expect(followUpBtns[0]).toBeDisabled();
        expect(followUpBtns[1]).toBeDisabled();

        fireEvent.click(followUpBtns[1]);
        expect(onFollowUp).not.toHaveBeenCalled();
    });

    test('Follow Up button indicates "Selected" state', () => {
        mockGetSelectedResponseForBlock.mockReturnValue('msg-2'); // Msg 2 selected
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={jest.fn()} />);

        const btns = screen.getAllByTestId('follow-up-button'); 
        expect(btns).toHaveLength(2);
        
        // The second button (for msg-2) should say 'Selected' and be disabled
        expect(btns[1]).toHaveTextContent('Selected');
        expect(btns[1]).toBeDisabled();

        // The first button should not say 'Selected'
        expect(btns[0]).not.toHaveTextContent('Selected');
        expect(btns[0]).not.toBeDisabled();
    });
    test('shows Stop button and NO follow up button if content is loading', () => {
        const loadingMsgs = [
            { messageId: 'msg-loading', text: 'Generating...', aiVendor: AIVendor.OPENAI, isLoading: true, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={loadingMsgs} onFollowUp={jest.fn()} data-testid="res-comp" />);

        // Should render content and stop button, but NO follow up button
        expect(screen.getByTestId('res-comp')).toBeInTheDocument();
        expect(screen.getByTestId('stop-button')).toBeInTheDocument();
        expect(screen.queryByTestId('follow-up-button')).not.toBeInTheDocument();
    });

    test('renders token badge when input, output, total, and cache tokens are provided', () => {
        const msgsWithTokens = [
            {
                messageId: 'msg-tokens',
                text: 'Here is a response',
                aiVendor: AIVendor.OPENAI,
                isLoading: false,
                inputTokens: 1234,
                outputTokens: 567,
                totalTokens: 1801,
                tokensReadFromCache: 0,
            }
        ];
        render(<Response blockId="block-1" responseMessages={msgsWithTokens} onFollowUp={jest.fn()} />);

        // Check if all token counts are rendered
        expect(screen.getByText('1,234')).toBeInTheDocument();
        expect(screen.getByText('567')).toBeInTheDocument();
        expect(screen.getByText('1,801')).toBeInTheDocument();
        // "0" appears both as the cache-token count and the learned-facts count
        expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
    });

    test('does not render token badge when tokens are null or undefined', () => {
        const msgsWithoutTokens = [
            {
                messageId: 'msg-no-tokens',
                text: 'Here is a response without tokens',
                aiVendor: AIVendor.OPENAI,
                isLoading: false
            }
        ];
        render(<Response blockId="block-1" responseMessages={msgsWithoutTokens} onFollowUp={jest.fn()} />);

        // Check if token titles are ABSENT
        expect(screen.queryByTitle('Input tokens')).not.toBeInTheDocument();
        expect(screen.queryByTitle('Output tokens')).not.toBeInTheDocument();
    });

    test('handles Regenerate click', () => {
        const mockGenerateResponsesStream = jest.fn();
        mockUseConversation.mockReturnValue({
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            getVendorSelectionForBlock: () => mockSelection,
            setVendorSelectionForBlock: mockSetVendorSelectionForBlock,
            generateResponsesStream: mockGenerateResponsesStream,
            stopGenerating: jest.fn()
        });

        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={jest.fn()} />);

        const regenerateBtns = screen.getAllByTestId('regenerate-button');
        expect(regenerateBtns).toHaveLength(2); // Should show for all responses
        fireEvent.click(regenerateBtns[0]); // Click the first one (msg-1 / OpenAI)

        expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', undefined, undefined, AIVendor.OPENAI);
    });

    test('Regenerate button disabled if props.disabled is true', () => {
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={jest.fn()} disabled={true} />);

        const regenerateBtns = screen.getAllByTestId('regenerate-button');
        expect(regenerateBtns[0]).toBeDisabled();
        expect(regenerateBtns[1]).toBeDisabled();
    });

    // --- Vendor toggle + thinking (merged from the former ResponseThinking widget) ---

    test('shows no toggle group for a single vendor', () => {
        render(<Response blockId="block-1" responseMessages={[mockMessages[0]]} />);
        expect(screen.queryByTestId('vendor-radio-group')).not.toBeInTheDocument();
        expect(screen.queryByTestId('vendor-checkbox-group')).not.toBeInTheDocument();
    });

    test('shows the checkbox group when vendors fit the column limit', () => {
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE];
        render(<Response blockId="block-1" responseMessages={mockMessages} />);

        expect(screen.getByTestId('vendor-checkbox-group')).toBeInTheDocument();
        expect(screen.queryByTestId('vendor-radio-group')).not.toBeInTheDocument();
    });

    test('shows the radio group when vendors exceed the column limit', () => {
        mockMaxVendors = 2;
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE, AIVendor.GEMINI];
        const threeVendors = [
            ...mockMessages,
            { messageId: 'msg-3', text: 'Response 3', aiVendor: AIVendor.GEMINI, isLoading: false, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={threeVendors} />);

        expect(screen.getByTestId('vendor-radio-group')).toBeInTheDocument();
        expect(screen.queryByTestId('vendor-checkbox-group')).not.toBeInTheDocument();
    });

    test('radio group selection replaces the previous vendor selection', () => {
        mockMaxVendors = 2;
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE, AIVendor.GEMINI];
        const threeVendors = [
            ...mockMessages,
            { messageId: 'msg-3', text: 'Response 3', aiVendor: AIVendor.GEMINI, isLoading: false, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={threeVendors} />);

        fireEvent.click(screen.getByTestId(`vendor-radio-group-option-${AIVendor.GEMINI}`));

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('block-1', [AIVendor.GEMINI]);
    });

    test('checkbox group keeps other selections when below the limit', () => {
        mockSelection = [AIVendor.OPENAI];
        render(<Response blockId="block-1" responseMessages={mockMessages} />);

        fireEvent.click(screen.getByTestId(`vendor-checkbox-group-option-${AIVendor.CLAUDE}`));

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('block-1', [AIVendor.OPENAI, AIVendor.CLAUDE]);
    });

    test('auto-selects vendors that appear for the first time', () => {
        mockSelection = [];
        render(<Response blockId="block-1" responseMessages={[mockMessages[0]]} />);

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('block-1', [AIVendor.OPENAI]);
    });

    test('renders the thinking section inside the response card for messages with steps', () => {
        mockSelection = [AIVendor.OPENAI];
        const withThinking = [
            { messageId: 'msg-1', text: 'Answer', aiVendor: AIVendor.OPENAI, isLoading: false, thinkingSteps: ['pondering deeply'], timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={withThinking} />);

        expect(screen.getByTestId('thinking-section')).toBeInTheDocument();
        expect(screen.getByText('Thinking')).toBeInTheDocument();
    });

    test('omits the thinking section for messages without steps', () => {
        render(<Response blockId="block-1" responseMessages={mockMessages} />);
        expect(screen.queryByTestId('thinking-section')).not.toBeInTheDocument();
    });

    test('shows a single "Thinking" label (no placeholder) while steps have not arrived', () => {
        mockSelection = [AIVendor.OPENAI];
        const thinkingMsg = [
            { messageId: 'msg-1', text: '', aiVendor: AIVendor.OPENAI, isLoading: true, thinkingSteps: [], timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={thinkingMsg} />);

        expect(screen.getAllByText('Thinking')).toHaveLength(1);
        expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    });

    test('shows "Thought for x seconds" once thinking is complete', () => {
        mockSelection = [AIVendor.OPENAI];
        const withDuration = [
            { messageId: 'msg-1', text: 'Answer', aiVendor: AIVendor.OPENAI, isLoading: false, thinkingSteps: ['step one'], thinkingDurationMs: 4321, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={withDuration} />);

        expect(screen.getByText('Thought for 4 seconds')).toBeInTheDocument();
        expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    });

    test('keeps the "Thinking" label while still thinking, even if duration is unset', () => {
        mockSelection = [AIVendor.OPENAI];
        const stillThinking = [
            { messageId: 'msg-1', text: '', aiVendor: AIVendor.OPENAI, isLoading: true, thinkingSteps: ['step one'], timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={stillThinking} />);

        expect(screen.getByText('Thinking')).toBeInTheDocument();
    });

    test('thinking section collapses and expands via its toggle', () => {
        mockSelection = [AIVendor.OPENAI];
        const withThinking = [
            { messageId: 'msg-1', text: 'Answer', aiVendor: AIVendor.OPENAI, isLoading: false, thinkingSteps: ['step one'], timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={withThinking} />);

        // Not thinking anymore → starts collapsed (auto-collapse on completion)
        expect(screen.queryByText('step one')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
        expect(screen.getByText('step one')).toBeInTheDocument();
    });

    test('renders structured thinking steps (name, detail, items) from thinkingStepList', () => {
        mockSelection = [AIVendor.OPENAI];
        const withStructured = [
            {
                messageId: 'msg-1', text: 'Answer', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0,
                thinkingStepList: [
                    { node: 'retriever', name: 'Document Retriever', kind: 'RETRIEVAL' as const, status: 'done' as const, detail: 'Found 1 relevant document(s)', items: ['Q3 sales report'] }
                ]
            }
        ];
        render(<Response blockId="block-1" responseMessages={withStructured} />);

        // Completed thinking starts collapsed — expand it
        fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
        expect(screen.getByTestId('thinking-step-list')).toBeInTheDocument();
        expect(screen.getByText('Document Retriever')).toBeInTheDocument();
        expect(screen.getByText('Found 1 relevant document(s)')).toBeInTheDocument();
        expect(screen.getByText('Q3 sales report')).toBeInTheDocument();
    });

    test('renders legacy flat strings and structured steps together', () => {
        mockSelection = [AIVendor.OPENAI];
        const mixed = [
            {
                messageId: 'msg-1', text: '', aiVendor: AIVendor.OPENAI, isLoading: true, timestamp: 0,
                thinkingSteps: ['legacy flat line'],
                thinkingStepList: [
                    { node: 'qa', name: 'Query Analyzer', kind: 'LLM' as const, status: 'running' as const, label: 'Query Analyzer: thinking…' }
                ]
            }
        ];
        render(<Response blockId="block-1" responseMessages={mixed} />);

        // Still thinking → section starts expanded
        expect(screen.getByText('legacy flat line')).toBeInTheDocument();
        expect(screen.getByText('Query Analyzer: thinking…')).toBeInTheDocument();
    });

    test('shows the model chip in the card header when the model is known', () => {
        const withModel = [
            { messageId: 'msg-1', text: 'Answer', aiVendor: AIVendor.OPENAI, model: 'gpt-4o', isLoading: false, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={withModel} />);

        expect(screen.getByTestId('response-model-name')).toHaveTextContent('gpt-4o');
    });

    test('omits the model name when unknown', () => {
        render(<Response blockId="block-1" responseMessages={[mockMessages[0]]} />);
        expect(screen.queryByTestId('response-model-name')).not.toBeInTheDocument();
    });

    test('only renders the latest message per vendor', () => {
        const messagesWithDuplicates = [
            { messageId: 'msg-1', text: 'Response 1', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0 },
            { messageId: 'msg-2', text: 'Response 2', aiVendor: AIVendor.CLAUDE, isLoading: false, timestamp: 0 },
            { messageId: 'msg-3', text: 'Response 3 (Latest)', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0 }
        ];

        render(<Response blockId="block-1" responseMessages={messagesWithDuplicates} data-testid="res-comp" />);
        
        // Should only render 2 messages (one for OpenAI, one for Claude)
        expect(screen.getAllByTestId('response-message')).toHaveLength(2);
        
        // Ensure the latest OpenAI message text is what's rendered, not the first
        expect(screen.getByText('Response 3 (Latest)')).toBeInTheDocument();
        expect(screen.queryByText('Response 1')).not.toBeInTheDocument();
    });

    describe('learned facts stat', () => {
        const withConversation = (overrides = {}) => {
            mockUseConversation.mockReturnValue({
                setSelectedResponseForBlock: mockSetSelectedResponseForBlock,
                getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
                getVendorSelectionForBlock: () => mockSelection,
                setVendorSelectionForBlock: mockSetVendorSelectionForBlock,
                generateResponsesStream: jest.fn(),
                stopGenerating: jest.fn(),
                conversationId: 'conv-1',
                ...overrides,
            });
        };

        const baseMessage = {
            messageId: '11111111-aaaa-4bbb-8ccc-000000000001',
            text: 'A response',
            aiVendor: AIVendor.OPENAI,
            isLoading: false,
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            tokensReadFromCache: 0,
        };

        const FACTS = [
            { memoryId: 'mem-1', text: 'Prefers dark mode' },
            { memoryId: 'mem-2', text: 'Works in fintech' },
        ];

        /** Hover helper — the Tooltip's mouse handlers live on its wrapper div */
        const hoverFactsCount = () => {
            const trigger = screen.getByTestId('learned-facts-count');
            fireEvent.mouseEnter(trigger.parentElement);
        };

        afterEach(() => {
            jest.useRealTimers();
        });

        test('fresh response shows the pending brain then the fact count once extraction finishes', async () => {
            jest.useFakeTimers();
            withConversation();
            getLearnedFacts
                .mockResolvedValueOnce({ status: 'pending', facts: [] })
                .mockResolvedValueOnce({ status: 'done', facts: FACTS });

            render(<Response blockId="block-1" responseMessages={[baseMessage]} />);

            expect(screen.getByTestId('learned-facts-pending')).toHaveAccessibleName('Learning facts…');

            // First (immediate) poll: still pending
            await act(async () => { await Promise.resolve(); });
            expect(screen.getByTestId('learned-facts-pending')).toBeInTheDocument();

            // Next poll 4s later: done with 2 facts
            await act(async () => { jest.advanceTimersByTime(4000); });
            expect(screen.getByTestId('learned-facts-count')).toHaveTextContent('2');
            expect(screen.getByTestId('learned-facts-count')).toHaveAccessibleName('2 facts added to memory');
            expect(getLearnedFacts).toHaveBeenCalledWith('tok', 'conv-1', baseMessage.messageId);
        });

        test('fresh response with no learned facts settles on a zero count', async () => {
            withConversation();
            getLearnedFacts.mockResolvedValue({ status: 'done', facts: [] });

            render(<Response blockId="block-1" responseMessages={[baseMessage]} />);

            await act(async () => { await Promise.resolve(); });
            expect(screen.getByTestId('learned-facts-none')).toHaveTextContent('0');
            expect(screen.getByTestId('learned-facts-none')).toHaveAccessibleName('No new facts added to memory');
        });

        test('historical message renders its facts directly without polling', async () => {
            withConversation();

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: FACTS }]} />);

            expect(screen.getByTestId('learned-facts-count')).toHaveTextContent('2');
            await act(async () => { await Promise.resolve(); });
            expect(getLearnedFacts).not.toHaveBeenCalled();
        });

        test('historical message with a single fact uses the singular label', () => {
            withConversation();

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: [FACTS[0]] }]} />);

            expect(screen.getByTestId('learned-facts-count')).toHaveTextContent('1');
            expect(screen.getByTestId('learned-facts-count')).toHaveAccessibleName('1 fact added to memory');
        });

        test('historical message with unknown outcome (null) shows "No new facts" without polling', async () => {
            withConversation();

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: null }]} />);

            expect(screen.getByTestId('learned-facts-none')).toBeInTheDocument();
            await act(async () => { await Promise.resolve(); });
            expect(getLearnedFacts).not.toHaveBeenCalled();
        });

        test('hovering the count reveals a tooltip listing each fact', async () => {
            withConversation();

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: FACTS }]} />);

            hoverFactsCount();

            const list = await screen.findByTestId('learned-facts-list');
            expect(list).toBeInTheDocument();
            expect(screen.getByText('Prefers dark mode')).toBeInTheDocument();
            expect(screen.getByText('Works in fintech')).toBeInTheDocument();
            expect(screen.getAllByTestId('learned-fact-delete')).toHaveLength(2);
        });

        test('clicking ✗ deletes the fact, removes its line and adjusts the count', async () => {
            withConversation();
            deleteMemoryFact.mockResolvedValue(undefined);

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: FACTS }]} />);

            hoverFactsCount();
            await screen.findByTestId('learned-facts-list');

            fireEvent.click(screen.getByRole('button', { name: 'Delete fact from memory: Prefers dark mode' }));

            await act(async () => { await Promise.resolve(); });
            expect(deleteMemoryFact).toHaveBeenCalledWith('tok', 'mem-1');
            expect(screen.queryByText('Prefers dark mode')).not.toBeInTheDocument();
            expect(screen.getByText('Works in fintech')).toBeInTheDocument();
            expect(screen.getByTestId('learned-facts-count')).toHaveAccessibleName('1 fact added to memory');
        });

        test('deleting the last fact switches to the none-state', async () => {
            withConversation();
            deleteMemoryFact.mockResolvedValue(undefined);

            render(<Response blockId="block-1" responseMessages={[{ ...baseMessage, learnedFacts: [FACTS[0]] }]} />);

            hoverFactsCount();
            await screen.findByTestId('learned-facts-list');

            fireEvent.click(screen.getByTestId('learned-fact-delete'));
            await act(async () => { await Promise.resolve(); });

            expect(screen.queryByTestId('learned-facts-count')).not.toBeInTheDocument();
            expect(screen.getByTestId('learned-facts-none')).toBeInTheDocument();
        });

        test('does not poll for errored or still-placeholder messages', async () => {
            withConversation();

            const erroredMsg = { ...baseMessage, error: 'boom' };
            const abortedMsg = { ...baseMessage, messageId: 'resp-123-0', aiVendor: AIVendor.CLAUDE };
            render(<Response blockId="block-1" responseMessages={[erroredMsg, abortedMsg]} />);

            await act(async () => { await Promise.resolve(); });
            expect(getLearnedFacts).not.toHaveBeenCalled();
        });
    });

    describe('web-search citations', () => {
        const webSources = [
            { index: 1, title: 'Fed holds rates', url: 'https://example.com/fed' },
            { index: 2, title: 'Market reaction', url: 'https://example.com/mkt' }
        ];

        test('linkifies known [n] markers in the content and leaves unknown ones', () => {
            const messages = [{
                messageId: 'msg-1',
                text: 'Rates held [1] and markets rallied [2]. Unknown [9].',
                aiVendor: AIVendor.OPENAI,
                isLoading: false,
                webSources
            }];
            render(<Response blockId="block-1" responseMessages={messages} />);
            // The mocked TextContainer renders the raw content string
            expect(screen.getByTestId('tc-content')).toHaveTextContent(
                'Rates held [[1]](https://example.com/fed) and markets rallied [[2]](https://example.com/mkt). Unknown [9].'
            );
        });

        test('renders a sources list with links once loading finishes', () => {
            const messages = [{
                messageId: 'msg-1',
                text: 'Cited answer [1]',
                aiVendor: AIVendor.OPENAI,
                isLoading: false,
                webSources
            }];
            render(<Response blockId="block-1" responseMessages={messages} />);
            const section = screen.getByTestId('sources-section');
            expect(section).toBeInTheDocument();
            const links = section.querySelectorAll('a');
            expect(links).toHaveLength(2);
            expect(links[0]).toHaveAttribute('href', 'https://example.com/fed');
            expect(links[0]).toHaveTextContent('Fed holds rates');
            expect(links[1]).toHaveAttribute('href', 'https://example.com/mkt');
        });

        test('hides the sources list while the message is still streaming', () => {
            const messages = [{
                messageId: 'msg-1',
                text: 'partial [1]',
                aiVendor: AIVendor.OPENAI,
                isLoading: true,
                webSources
            }];
            render(<Response blockId="block-1" responseMessages={messages} />);
            expect(screen.queryByTestId('sources-section')).not.toBeInTheDocument();
        });

        test('renders no sources section when the message has no web sources', () => {
            render(<Response blockId="block-1" responseMessages={mockMessages} />);
            expect(screen.queryByTestId('sources-section')).not.toBeInTheDocument();
        });
    });
});

