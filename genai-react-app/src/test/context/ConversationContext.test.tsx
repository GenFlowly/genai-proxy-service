import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { ToastProvider } from '../../context/ToastContext';
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
import * as generateTextStreamService from '../../services/generateTextStreamService';

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
jest.mock('../../context/AIContext', () => ({
    useAI: () => mockUseAI(),
    AIProvider: ({ children }: any) => children
}));

const TestConversationUI = () => {
    const { conversationBlockList, addNewConversationBlock } = useConversation();

    // Auto-add a block if empty for testing
    React.useEffect(() => {
        if (conversationBlockList.length === 0) {
            addNewConversationBlock();
        }
    }, [conversationBlockList.length, addNewConversationBlock]);

    return (
        <div>
            {conversationBlockList.map(block => (
                <div key={block.conversationBlockId} data-testid="conversation-block">
                    <Request blockId={block.conversationBlockId} />
                    <Response
                        blockId={block.conversationBlockId}
                        responseMessages={block.responseMessages}
                    />
                </div>
            ))}
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

        // Default Auth Mock
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            customerId: 'cust-123',
            getAccessTokenSilently: jest.fn().mockResolvedValue('fake-token'),
            aiVendorAPIKeyStatusList: [{ aiVendor: AIVendor.CLAUDE, isAPIKeyValid: true }],
            user: { name: 'Test User' }
        });

        // Default AI Mock
        mockUseAI.mockReturnValue({
            config: [{ aiVendor: AIVendor.CLAUDE, model: 'claude-3-haiku-20240307' }],
            systemPrompt: 'You are an tax expert...',
            setSystemPrompt: jest.fn(),
            setSupplementalText: jest.fn(),
        });
    });

    test('Flow: Enter Prompt -> Generate Stream -> Receive Response', async () => {
        (generateTextStreamService.generateTextStream as jest.Mock).mockImplementation(
            async (token, payload, onDelta, onMetadata) => {
                // Simulate stream delay
                onDelta('Hello! ');
                await new Promise(r => setTimeout(r, 10));
                onDelta('How can I assist you today?');
                onMetadata({ conversationId: 'conv-1', responseMessageId: 'resp-1' });
            }
        );

        customRender(<TestConversationUI />);

        // 1. Verify Request Widget Loaded
        const editor = await screen.findByTestId('prompt-editor');
        expect(editor).toBeInTheDocument();

        // 2. Type Prompt
        fireEvent.change(editor, { target: { value: 'hi' } });
        expect(editor).toHaveValue('hi');

        // 3. Click Generate
        const generateBtn = screen.getByTestId('generate-button');
        expect(generateBtn).toBeEnabled();

        await act(async () => {
            fireEvent.click(generateBtn);
        });

        // 4. Verify Stream Service Called with expected payload structure
        expect(generateTextStreamService.generateTextStream).toHaveBeenCalledWith(
            'fake-token',
            expect.objectContaining({
                prompt: {
                    prompt: 'hi',
                    systemPrompt: 'You are an tax expert...'
                },
                aiConfig: expect.objectContaining({
                    aiVendor: 'CLAUDE'
                })
            }),
            expect.any(Function),
            expect.any(Function)
        );

        // 5. Verify Response Appears
        // It streams, so we wait for text.
        await waitFor(() => {
            expect(screen.getByTestId('response-message')).toHaveTextContent('Hello! How can I assist you today?');
        });

        // 6. Verify Aria Label
        expect(screen.getByTestId('response-message')).toHaveAttribute('aria-label', 'Response from CLAUDE');
    });
});
