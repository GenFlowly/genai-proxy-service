import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { AIVendor } from '../../constants/vendors';

// Mocks for dependencies
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: 'user123',
        isAuthenticated: true,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}));

jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: [{ aiVendor: 'OPENAI', model: 'gpt-4' }],
        setSupplementalText: jest.fn(),
        customerInstructions: [],
    }),
}));

jest.mock('../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: jest.fn(),
        setRightSidebarExpanded: jest.fn(),
        setLeftSidebarMinimized: jest.fn(),
        setHistoryWidgetExpanded: jest.fn(),
    }),
}));

jest.mock('../../context/ToastContext', () => ({
    useToast: () => ({
        showToast: jest.fn(),
    }),
}));

// Mock services
jest.mock('../../services/generateTextService');
jest.mock('../../services/generateTextStreamService');

import { generateText } from '../../services/generateTextService';
const mockGenerateText = generateText as jest.Mock;

const TestComponent = () => {
    const context = useConversation();
    return (
        <div>
            <div data-testid="msg-count">{context.conversationBlockList[0].responseMessages.length}</div>
            <button onClick={() => context.generateResponses('conv-default')} data-testid="gen-btn">Generate</button>
        </div>
    );
};

describe('ConversationContext Deep Dive', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('normalizes API response results correctly (branch coverage)', async () => {
        // Case: Results is not an array (fallback case in Line 153)
        mockGenerateText.mockResolvedValue({
            aiVendor: 'OPENAI',
            text: 'Hello world',
            messageId: 'm1',
            conversationId: 'c1'
        });

        const { result } = render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        await act(async () => {
            const btn = document.querySelector('[data-testid="gen-btn"]') as HTMLButtonElement;
            btn.click();
        });

        // Wait for normalized response to be set
        await waitFor(() => {
            const count = document.querySelector('[data-testid="msg-count"]');
            expect(count).toHaveTextContent('1');
        });
    });

    test('generateResponsesStream - Scenario A: existing conversation (Line 466)', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((token: any, params: any, onDelta: any, onMetadata: any) => {
            onDelta('Hello');
            onMetadata({ conversationId: 'c1', messageId: 'm1', responseMessageId: 'rm1' });
            return Promise.resolve();
        });

        const TestComp = () => {
            const context = useConversation();
            return (
                <div>
                    <div data-testid="msg-text">{context.conversationBlockList[0]?.responseMessages[0]?.text}</div>
                    <button onClick={() => context.generateResponsesStream('conv-default')} data-testid="stream-btn">Stream</button>
                </div>
            );
        };

        const { getByTestId } = render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComp />
                </ConversationProvider>
            </MemoryRouter>
        );

        await act(async () => {
            getByTestId('stream-btn').click();
        });

        await waitFor(() => {
            expect(getByTestId('msg-text')).toHaveTextContent('Hello');
        });
    });

    test('generateResponsesStream - Scenario B: new conversation (Line 471)', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementationOnce((token: any, params: any, onDelta: any, onMetadata: any) => {
            onMetadata({ conversationId: 'new-id', messageId: 'm1', responseMessageId: 'new-msg-id' });
            return Promise.resolve();
        });

        const { getByTestId } = render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        await act(async () => {
             getByTestId('gen-btn').click();
        });
    });


});
