import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { generateTextStream } from '../../services/generateTextStreamService';
import { createConversationTitle } from '../../services/createConversationTitleService';
import { markConversationRead } from '../../services/conversationHistoryService';

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: 'user123',
        isAuthenticated: true,
        isSessionAuthenticated: true,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}));

jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: [{ aiVendor: 'OPENAI', model: 'gpt-4' }],
        setSupplementalText: jest.fn(),
        customerInstructions: [],
        systemPrompt: '',
        setSystemPrompt: jest.fn(),
        selectedInstructionId: null,
        setSelectedInstructionId: jest.fn(),
        selectedAgentId: null,
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

jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast: jest.fn() }) }));

jest.mock('../../services/generateTextStreamService', () => ({
    ...jest.requireActual('../../services/generateTextStreamService'),
    generateTextStream: jest.fn(),
}));
jest.mock('../../services/reattachRunService');
jest.mock('../../services/conversationService');
jest.mock('../../services/conversationHistoryService');
jest.mock('../../services/cancelGenerationService');
jest.mock('../../services/generateTextService');
jest.mock('../../services/getAIUsageService');
jest.mock('../../services/createConversationTitleService');

const mockGenerate = generateTextStream as jest.Mock;
const mockCreateTitle = createConversationTitle as jest.Mock;
const mockMarkRead = markConversationRead as jest.Mock;

const Tester = () => {
    const conversation = useConversation();
    const location = useLocation();
    const block = conversation.conversationBlockList[0];
    return (
        <div>
            <div data-testid="path">{location.pathname}</div>
            <div data-testid="block">{block?.conversationBlockId ?? ''}</div>
            <div data-testid="prompt">{block?.prompt ?? ''}</div>
            <div data-testid="status">{block?.status ?? ''}</div>
            <div data-testid="responses">{block?.responseMessages.length ?? 0}</div>
            <div data-testid="title">{conversation.conversationTitle ?? ''}</div>
            <button data-testid="stream" onClick={() => conversation.generateResponsesStream('conv-default', 'Old question')}>stream</button>
            <button data-testid="reset" onClick={() => conversation.resetConversation()}>reset</button>
        </div>
    );
};

const renderTester = () => render(<MemoryRouter initialEntries={['/chat']}><ConversationProvider><Tester /></ConversationProvider></MemoryRouter>);

describe('ConversationContext when the user leaves a new chat mid-reply', () => {
    test('the reply finishing later leaves the new chat alone', async () => {
        let finish: () => void = () => {};
        mockGenerate.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c-old', responseMessageId: 'rm1' });
            args[2]?.('partial');
            return new Promise<void>(resolve => { finish = resolve; });
        });
        let nameIt: (value: { title: string }) => void = () => {};
        mockCreateTitle.mockReturnValue(new Promise(resolve => { nameIt = resolve; }));

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });
        await act(async () => { getByTestId('reset').click(); });

        await act(async () => { nameIt({ title: 'Old title' }); });
        // The left turn's metadata arrives again after New Chat.
        await act(async () => { mockGenerate.mock.calls[0][3]?.({ conversationId: 'c-old', responseMessageId: 'rm1' }); });
        await act(async () => { finish(); });

        expect(getByTestId('path')).toHaveTextContent(/^\/chat$/);
        expect(getByTestId('prompt')).toHaveTextContent(/^$/);
        expect(getByTestId('status')).toHaveTextContent('draft');
        expect(getByTestId('responses')).toHaveTextContent('0');
        expect(getByTestId('block')).not.toHaveTextContent('conv-default');
        expect(getByTestId('title')).toHaveTextContent(/^$/);
        // The reply finished away from the chat: it stays unread.
        expect(mockMarkRead).not.toHaveBeenCalled();
    });

    test('staying on the chat still opens it when the reply ends', async () => {
        mockGenerate.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c-new', responseMessageId: 'rm1' });
            args[2]?.('answer');
            return Promise.resolve();
        });
        mockCreateTitle.mockResolvedValue({ title: 'New title' });

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });

        expect(getByTestId('path')).toHaveTextContent('/chat/c-new');
        expect(getByTestId('prompt')).toHaveTextContent('Old question');
        expect(getByTestId('status')).toHaveTextContent('resolved');
        expect(getByTestId('title')).toHaveTextContent('New title');
    });
});
