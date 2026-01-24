import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { ToastProvider, useToast } from '../../context/ToastContext';
import { LayoutProvider } from '../../context/LayoutContext';
import { AuthProvider } from '../../context/AuthContext';
import { AIProvider } from '../../context/AIContext';
import { MemoryRouter } from 'react-router-dom';
import Request from '../../components/widgets/ConversationWidget/RequestWidget/Request';
import Response from '../../components/widgets/ConversationWidget/ResponseWidget/Response';
import { AIVendor } from '../../constants/vendors';

// Mock Services
jest.mock('../../services/generateTextStreamService', () => ({
    generateTextStream: jest.fn()
}));
jest.mock('../../services/conversationService', () => ({
    getConversation: jest.fn()
}));
jest.mock('../../services/generateTextService', () => ({
    generateText: jest.fn()
}));

import * as generateTextStreamService from '../../services/generateTextStreamService';
import * as conversationService from '../../services/conversationService';
import * as generateTextService from '../../services/generateTextService';

jest.mock('../../components/widgets/PromptEditorWidget/PromptEditor', () => (props: any) => (
    <div data-testid={`${props['data-testid']}-container`}>
        <textarea
            data-testid={props['data-testid'] || 'mock-prompt-editor'}
            aria-label="Prompt Editor"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
        />
    </div>
));

jest.mock('../../components/common/TextContainer/TextContainer', () => (props: any) => (
    <div data-testid={props['data-testid']} aria-label={props['aria-label']}>
        {props.content}
        {props.children}
    </div>
));

// Mock useToast to inspect calls
const mockShowToast = jest.fn();
jest.mock('../../context/ToastContext', () => ({
    useToast: () => ({ showToast: mockShowToast }),
    ToastProvider: ({ children }: any) => children
}));

const mockUseAuth = jest.fn();
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => mockUseAuth(),
    AuthProvider: ({ children }: any) => children
}));

const mockUseAI = jest.fn(() => ({
    config: [] as any[],
    systemPrompt: '',
    setSystemPrompt: jest.fn(),
    setSupplementalText: jest.fn(),
}));
const mockSetSupplementalText = jest.fn();
jest.mock('../../context/AIContext', () => ({
    useAI: () => ({ ...mockUseAI(), setSupplementalText: mockSetSupplementalText }),
    AIProvider: ({ children }: any) => children
}));

const TestConversationUI = () => {
    const {
        conversationBlockList,
        addNewConversationBlock,
        loadConversation,
        resetConversation,
        setSelectedResponseForBlock,
        activeBlockId,
        setActiveBlockId,
        generateResponses // Expose for testing
    } = useConversation();

    // Auto-add a block if empty for testing
    React.useEffect(() => {
        if (conversationBlockList.length === 0) {
            addNewConversationBlock();
        }
    }, [conversationBlockList.length, addNewConversationBlock]);

    return (
        <div>
            <div data-testid="active-block-id">{activeBlockId}</div>
            <div data-testid="conversastion-id-display">{/* We need to expose conversationId? no, check via mock/url? */}</div>

            {conversationBlockList.map((block, idx) => (
                <div key={block.conversationBlockId} data-testid="conversation-block">
                    <div data-testid="debug-prompt">{block.prompt}</div>
                    <div data-testid="debug-block-id">{block.conversationBlockId}</div>
                    <div data-testid="debug-response-text">{block.responseMessages[0]?.text}</div>
                    <div data-testid={`debug-response-count-${block.conversationBlockId}`}>{block.responseMessages.length}</div>

                    <button data-testid={`select-block-${block.conversationBlockId}`} onClick={() => setActiveBlockId(block.conversationBlockId)}>Select Block</button>
                    <button data-testid={`generate-legacy-${block.conversationBlockId}`} onClick={() => generateResponses(block.conversationBlockId)}>Generate Legacy</button>

                    <Request blockId={block.conversationBlockId} />
                    <Response
                        blockId={block.conversationBlockId}
                        responseMessages={block.responseMessages}
                    />
                </div>
            ))}
            <button onClick={() => loadConversation('conv-123')} data-testid="load-btn">Load</button>
            <button onClick={() => resetConversation()} data-testid="reset-btn">Reset</button>
            <button onClick={() => addNewConversationBlock()} data-testid="add-block-btn">Add Block</button>
        </div>
    );
};

const customRender = (ui: React.ReactElement) => {
    return render(
        <MemoryRouter>
            <ToastProvider>
                <LayoutProvider>
                    <AuthProvider>
                        <AIProvider>
                            <ConversationProvider>
                                {ui}
                            </ConversationProvider>
                        </AIProvider>
                    </AuthProvider>
                </LayoutProvider>
            </ToastProvider>
        </MemoryRouter>
    );
};

describe('ConversationContext UI Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSetSupplementalText.mockClear();

        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            customerId: 'cust-123',
            getAccessTokenSilently: jest.fn().mockResolvedValue('fake-token'),
            aiVendorAPIKeyStatusList: [
                { aiVendor: AIVendor.CLAUDE, isAPIKeyValid: true },
                { aiVendor: AIVendor.OPENAI, isAPIKeyValid: true }
            ],
            user: { name: 'Test User' }
        });

        mockUseAI.mockReturnValue({
            config: [{ aiVendor: AIVendor.CLAUDE, model: 'claude-3-haiku-20240307' }],
            systemPrompt: 'You are an tax expert...',
            setSystemPrompt: jest.fn(),
            setSupplementalText: mockSetSupplementalText,
        });
    });

    test('Flow: Enter Prompt -> Generate Stream -> Receive Response', async () => {
        (generateTextStreamService.generateTextStream as jest.Mock).mockImplementation(
            async (token, payload, onDelta, onMetadata) => {
                onDelta('Hello! ');
                await new Promise(r => setTimeout(r, 10));
                onDelta('How can I assist you today?');
                onMetadata({ conversationId: 'conv-1', responseMessageId: 'resp-1' });
            }
        );

        customRender(<TestConversationUI />);
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'hi' } });
        const generateBtn = screen.getByTestId('generate-button');

        await act(async () => {
            fireEvent.click(generateBtn);
        });

        await waitFor(() => {
            const debugText = screen.getByTestId('debug-response-text');
            expect(debugText).toHaveTextContent('Hello! How can I assist you today?');
        });
    });

    // ... (Keep existing validation/reset/load tests)

    test('Flow: Shows validation error if not logged in', async () => {
        mockUseAuth.mockReturnValue({
            isAuthenticated: false,
            customerId: null,
            aiVendorAPIKeyStatusList: [{ aiVendor: AIVendor.CLAUDE, isAPIKeyValid: true }]
        });
        customRender(<TestConversationUI />);
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'hi' } });
        const generateBtn = screen.getByTestId('generate-button');
        fireEvent.click(generateBtn);
        expect(mockShowToast).toHaveBeenCalledWith('Please log in first.');
        expect(generateTextStreamService.generateTextStream).not.toHaveBeenCalled();
    });

    test('Flow: Shows error if no vendors selected', async () => {
        mockUseAI.mockReturnValue({
            config: [],
            systemPrompt: '',
            setSystemPrompt: jest.fn(),
            setSupplementalText: mockSetSupplementalText,
        });
        customRender(<TestConversationUI />);
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'hi' } });
        const generateBtn = screen.getByTestId('generate-button');
        fireEvent.click(generateBtn);
        expect(mockShowToast).toHaveBeenCalledWith('Select at least one vendor and model.');
    });

    test('Flow: Handles API Error', async () => {
        (generateTextStreamService.generateTextStream as jest.Mock).mockRejectedValue(new Error('API Fail'));
        customRender(<TestConversationUI />);
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'fail' } });
        const generateBtn = screen.getByTestId('generate-button');
        await act(async () => { fireEvent.click(generateBtn); });
        await waitFor(() => {
            const debugText = screen.getByTestId('debug-response-text');
            expect(debugText).toHaveTextContent('Error generating text stream.');
        });
    });

    test('Flow: Load existing conversation', async () => {
        const mockData = {
            conversationId: 'conv-123',
            blocks: [{ conversationBlockId: 'blk-1', prompt: 'Loaded Prompt', responseMessages: [{ aiVendor: AIVendor.OPENAI, text: 'Loaded Response', messageId: 'm1' }] }]
        };
        (conversationService.getConversation as jest.Mock).mockResolvedValue(mockData);
        customRender(<TestConversationUI />);
        fireEvent.click(screen.getByTestId('load-btn'));
        await waitFor(() => expect(conversationService.getConversation).toHaveBeenCalledWith('fake-token', 'conv-123'));
        const debugPrompt = await screen.findByTestId('debug-prompt');
        expect(debugPrompt).toHaveTextContent('Loaded Prompt');
    });

    test('Flow: Reset conversation', async () => {
        const mockData = {
            conversationId: 'conv-123',
            blocks: [{ conversationBlockId: 'blk-1', prompt: 'Old', responseMessages: [] }]
        };
        (conversationService.getConversation as jest.Mock).mockResolvedValue(mockData);
        customRender(<TestConversationUI />);
        fireEvent.click(screen.getByTestId('load-btn'));
        await waitFor(() => expect(screen.getByTestId('debug-prompt')).toHaveTextContent('Old'));
        fireEvent.click(screen.getByTestId('reset-btn'));
        await waitFor(() => {
            const debugPrompts = screen.getAllByTestId('debug-prompt');
            expect(debugPrompts[0]).toHaveTextContent('');
            expect(debugPrompts).toHaveLength(1);
        });
    });

    test('Flow: Multi-model generation for new chat (Scenario B)', async () => {
        mockUseAI.mockReturnValue({
            config: [{ aiVendor: AIVendor.CLAUDE, model: 'claude-3' }, { aiVendor: AIVendor.OPENAI, model: 'gpt-4' }],
            systemPrompt: '',
            setSystemPrompt: jest.fn(),
            setSupplementalText: mockSetSupplementalText,
        });
        (generateTextStreamService.generateTextStream as jest.Mock).mockImplementation(
            async (token, payload, onDelta, onMetadata) => {
                onDelta('Chunk');
                if (payload.aiConfig.aiVendor === AIVendor.CLAUDE) {
                    onMetadata({ conversationId: 'new-conv-id', responseMessageId: 'resp-1' });
                } else {
                    onMetadata({ conversationId: 'new-conv-id', responseMessageId: 'resp-2' });
                }
            }
        );
        customRender(<TestConversationUI />);
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'multi' } });
        const generateBtn = screen.getByTestId('generate-button');
        await act(async () => { fireEvent.click(generateBtn); });
        await waitFor(() => expect(generateTextStreamService.generateTextStream).toHaveBeenCalledTimes(2));
    });

    test('Syncs supplemental text from previous block', async () => {
        customRender(<TestConversationUI />);
        (generateTextStreamService.generateTextStream as jest.Mock).mockImplementation(
            async (token, payload, onDelta, onMetadata) => {
                onDelta('Block 1 Response');
                onMetadata({ conversationId: 'c1', responseMessageId: 'r1' });
            }
        );
        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'prompt1' } });
        fireEvent.click(screen.getByTestId('generate-button'));

        await waitFor(() => {
            expect(screen.getByTestId('debug-response-text')).toHaveTextContent('Block 1 Response');
        });

        fireEvent.click(screen.getByTestId('add-block-btn'));
        await waitFor(() => {
            expect(mockSetSupplementalText).toHaveBeenCalledWith('Block 1 Response');
        });
    });

    test('Syncs supplemental text: clears if first block active', async () => {
        customRender(<TestConversationUI />);
        await waitFor(() => {
            expect(mockSetSupplementalText).toHaveBeenCalledWith('');
        });
    });

    /* ---------- NEW TEST FOR NON-STREAM GENERATION ---------- */
    test('Flow: Non-stream generation (Legacy/Fallback) Success', async () => {
        // Mock non-stream response
        (generateTextService.generateText as jest.Mock).mockResolvedValue({
            conversationId: 'legacy-conv-id',
            text: 'Legacy Response Text',
            aiVendor: AIVendor.CLAUDE,
            messageId: 'leg-msg-1'
        });

        customRender(<TestConversationUI />);

        // Find the block ID to use in button
        const blockIdDiv = await screen.findByTestId('debug-block-id');
        const blockId = blockIdDiv.textContent;

        const editor = await screen.findByTestId('prompt-editor');
        fireEvent.change(editor, { target: { value: 'legacy prompt' } });

        // Click Legacy Generate button
        const btn = screen.getByTestId(`generate-legacy-${blockId}`);
        await act(async () => {
            fireEvent.click(btn);
        });

        // Verify calls
        await waitFor(() => {
            expect(generateTextService.generateText).toHaveBeenCalled();
        });

        // Verify state update
        const debugText = screen.getByTestId('debug-response-text');
        expect(debugText).toHaveTextContent('Legacy Response Text');

        // Verify Conversation ID update branch (new id)
        // (We can check if a URL navigation happened if we mocked navigate, but here check console logs or similar side effects?
        // Or check if future calls use new ID. But simple check that it didn't crash and updated text is enough coverage for the block).
    });

    test('Flow: Non-stream generation handles error', async () => {
        (generateTextService.generateText as jest.Mock).mockRejectedValue(new Error('Legacy Fail'));
        customRender(<TestConversationUI />);

        const blockIdDiv = await screen.findByTestId('debug-block-id');
        const blockId = blockIdDiv.textContent;
        const btn = screen.getByTestId(`generate-legacy-${blockId}`);

        await act(async () => {
            fireEvent.click(btn);
        });

        await waitFor(() => {
            const debugText = screen.getByTestId('debug-response-text');
            expect(debugText).toHaveTextContent('Error generating text.'); // Note: Non-stream error message might be different
            // Code: text: 'Error generating text.', (line 312 of ConversationContext)
        });
    });
});
