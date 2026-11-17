import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import {
    generateTextStream,
    StreamGenerationError,
    StreamTruncatedError,
} from '../../services/generateTextStreamService';
import { getConversation } from '../../services/conversationService';
import { reattachRun } from '../../services/reattachRunService';
import { createConversationTitle } from '../../services/createConversationTitleService';

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
jest.mock('../../services/cancelGenerationService');
jest.mock('../../services/generateTextService');
jest.mock('../../services/getAIUsageService');
jest.mock('../../services/createConversationTitleService');

const mockGenerate = generateTextStream as jest.Mock;
const mockGetConversation = getConversation as jest.Mock;
const mockReattach = reattachRun as jest.Mock;
const mockCreateTitle = createConversationTitle as jest.Mock;

const Tester = () => {
    const conversation = useConversation();
    const message = conversation.conversationBlockList[0]?.responseMessages[0];
    return (
        <div>
            <div data-testid="text">{message?.text ?? ''}</div>
            <div data-testid="error">{message?.error ?? ''}</div>
            <div data-testid="loading">{String(!!message?.isLoading)}</div>
            <button data-testid="stream" onClick={() => conversation.generateResponsesStream('conv-default')}>stream</button>
            <button data-testid="load" onClick={() => conversation.loadConversation('c1')}>load</button>
        </div>
    );
};

const renderTester = () => render(<MemoryRouter><ConversationProvider><Tester /></ConversationProvider></MemoryRouter>);

const streamThatFails = (error: Error, partialText?: string) => {
    mockGenerate.mockImplementation((...args: any[]) => {
        args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' });
        if (partialText) args[2]?.(partialText);
        return Promise.reject(error);
    });
};

const saved = (text: string) => ({
    blocks: [{ responseMessages: [{ messageId: 'rm1', text }] }],
});

const RECOVERY_POLL_MS = 5000;

const pollIntervals = async (count: number) => {
    for (let i = 0; i < count; i++) {
        await act(async () => { jest.advanceTimersByTime(RECOVERY_POLL_MS); });
    }
};

describe('ConversationContext after a failed stream', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockCreateTitle.mockResolvedValue({ title: 'A title' });
    });
    afterEach(() => jest.useRealTimers());

    test('a failure with no text shows the error at once, with nothing to poll for', async () => {
        streamThatFails(new StreamGenerationError('Provider said no'));

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });

        await act(async () => {});
        expect(getByTestId('error')).toHaveTextContent('Provider said no');
        expect(getByTestId('loading')).toHaveTextContent('false');
        await pollIntervals(2);
        expect(mockGetConversation).not.toHaveBeenCalled();
    });

    test('a failure after some text looks for the saved copy once and keeps the error', async () => {
        streamThatFails(new StreamGenerationError('Provider said no'), 'partial');
        mockGetConversation.mockResolvedValue({ blocks: [] });

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });

        await pollIntervals(4);
        expect(getByTestId('error')).toHaveTextContent('Provider said no');
        expect(getByTestId('text')).toHaveTextContent('partial');
        expect(getByTestId('loading')).toHaveTextContent('false');
        expect(mockGetConversation).toHaveBeenCalledTimes(1);
    });

    test('a saved copy of a failed response still replaces the text and stays flagged', async () => {
        streamThatFails(new StreamGenerationError('Provider said no'), 'partial');
        mockGetConversation.mockResolvedValue(saved('partial saved'));

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });

        await pollIntervals(1);
        expect(getByTestId('text')).toHaveTextContent('partial saved');
        expect(getByTestId('error')).toHaveTextContent('Provider said no');
    });

    test('a lost connection keeps polling until the saved response appears', async () => {
        streamThatFails(new StreamTruncatedError('Connection lost'));
        mockGetConversation
            .mockResolvedValueOnce({ blocks: [] })
            .mockResolvedValueOnce({ blocks: [] })
            .mockResolvedValue(saved('the full answer'));

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('stream').click(); });

        await pollIntervals(2);
        expect(getByTestId('text')).toHaveTextContent('');
        expect(getByTestId('loading')).toHaveTextContent('true');
        await pollIntervals(1);
        expect(getByTestId('text')).toHaveTextContent('the full answer');
        expect(mockGetConversation).toHaveBeenCalledTimes(3);
        expect(getByTestId('error').textContent).toBe('');
    });

    test('a pending run that turns out to have failed shows why, without polling', async () => {
        mockGetConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{ conversationBlockId: 'b1', prompt: { prompt: 'hi' }, responseMessages: [{ messageId: 'rm1', text: '', isLoading: false }] }],
            role: 'OWNER',
            pendingRuns: [{ messageId: 'rm1', runId: 'run-1' }],
        });
        mockReattach.mockRejectedValue(new StreamGenerationError('Provider said no'));

        const { getByTestId } = renderTester();
        await act(async () => { getByTestId('load').click(); });

        await pollIntervals(2);
        expect(getByTestId('error')).toHaveTextContent('Provider said no');
        expect(getByTestId('loading')).toHaveTextContent('false');
        expect(mockGetConversation).toHaveBeenCalledTimes(1);
    });
});
