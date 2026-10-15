import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';

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

jest.mock('../../services/generateTextStreamService');
jest.mock('../../services/reattachRunService');
jest.mock('../../services/resumeRunService');
jest.mock('../../services/conversationService');
jest.mock('../../services/cancelGenerationService');
jest.mock('../../services/generateTextService');
jest.mock('../../services/getAIUsageService');
jest.mock('../../services/createConversationTitleService');

const LOST = 'The response was lost when the server restarted.';

/** The error the stream service throws for an "err" frame (matched by name). */
const streamFailure = (message: string) => {
    const err = new Error(message);
    err.name = 'StreamGenerationError';
    return err;
};

const Probe = () => {
    const c = useConversation();
    const m = c.conversationBlockList[0]?.responseMessages[0];
    return (
        <div>
            <div data-testid="text">{m?.text ?? ''}</div>
            <div data-testid="error">{m?.error ?? ''}</div>
            <div data-testid="loading">{String(!!m?.isLoading)}</div>
            <button data-testid="stream" onClick={() => c.generateResponsesStream('conv-default')}>stream</button>
            <button data-testid="load" onClick={() => c.loadConversation('c1')}>load</button>
        </div>
    );
};

const renderProbe = () =>
    render(<MemoryRouter><ConversationProvider><Probe /></ConversationProvider></MemoryRouter>);

/** A conversation whose latest turn is still generating on durable run run-9. */
const pendingConversation = {
    conversationId: 'c1',
    blocks: [{
        conversationBlockId: 'b1',
        prompt: 'Write the report',
        responseMessages: [{ messageId: 'real-rm', aiVendor: 'OPENAI', text: '', isLoading: true }],
        isLoading: true,
        status: 'resolved',
    }],
    role: 'OWNER', title: null, instructionId: null,
    pendingRuns: [{ messageId: 'real-rm', runId: 'run-9' }],
};

/** The same turn as stored after the run failed. */
const failedConversation = {
    ...pendingConversation,
    blocks: [{
        ...pendingConversation.blocks[0],
        responseMessages: [{ messageId: 'real-rm', aiVendor: 'OPENAI', text: '', isLoading: false, error: LOST }],
        isLoading: false,
    }],
    pendingRuns: [],
};

describe('ConversationContext failed turns', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('an "err" frame fails the response at once, keeping the partial text, without polling for a recovery', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((...args: any[]) => {
            args[2]?.('Half of the ');
            args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' });
            return Promise.reject(streamFailure('Provider quota exceeded'));
        });
        const { getConversation } = require('../../services/conversationService');
        const { getAIUsageActivity } = require('../../services/getAIUsageService');

        const { getByTestId } = renderProbe();
        await act(async () => { getByTestId('stream').click(); });

        await waitFor(() => expect(getByTestId('error')).toHaveTextContent('Provider quota exceeded'));
        expect(getByTestId('text')).toHaveTextContent('Half of the');
        expect(getByTestId('loading')).toHaveTextContent('false');
        // The failure is final and stored server-side: nothing to poll for
        expect(getConversation).not.toHaveBeenCalled();
        expect(getAIUsageActivity).not.toHaveBeenCalled();
    });

    test('a dropped connection shows the stored error of a turn that failed meanwhile', async () => {
        jest.useFakeTimers();
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c1', responseMessageId: 'real-rm' });
            return Promise.reject(new Error('network error'));
        });
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue(failedConversation);

        const { getByTestId } = renderProbe();
        await act(async () => { getByTestId('stream').click(); });

        // The recovery poll (every 5 s) finds the stored message with its error
        await waitFor(() => expect(getByTestId('error')).toHaveTextContent(LOST), { timeout: 15000 });
        expect(getConversation).toHaveBeenCalledWith('token', 'c1');
        expect(getByTestId('loading')).toHaveTextContent('false');
    });

    test('reattach: a failed run\'s "err" frame shows its error under the replayed text', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue(pendingConversation);
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_t: any, _r: any, _c: any, cb: any) => {
            cb.onDelta('The first section');
            return Promise.reject(streamFailure(LOST));
        });
        const { getAIUsageActivity } = require('../../services/getAIUsageService');
        getAIUsageActivity.mockResolvedValue(null);

        const { getByTestId } = renderProbe();
        await act(async () => { getByTestId('load').click(); });

        await waitFor(() => expect(getByTestId('error')).toHaveTextContent(LOST));
        expect(getByTestId('text')).toHaveTextContent('The first section');
        await waitFor(() => expect(getByTestId('loading')).toHaveTextContent('false'));
        // Only the initial load: the stream already said how the run ended
        expect(getConversation).toHaveBeenCalledTimes(1);
    });

    test('reattach to a run that already finished (404) shows the stored error right away', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation
            .mockResolvedValueOnce(pendingConversation)
            .mockResolvedValue(failedConversation);
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockResolvedValue('gone');
        const { getAIUsageActivity } = require('../../services/getAIUsageService');
        getAIUsageActivity.mockResolvedValue(null);

        const { getByTestId } = renderProbe();
        await act(async () => { getByTestId('load').click(); });

        // No 5 s wait: a run that is gone is checked immediately
        await waitFor(() => expect(getByTestId('error')).toHaveTextContent(LOST), { timeout: 1500 });
        expect(getByTestId('loading')).toHaveTextContent('false');
        expect(reattachRun).toHaveBeenCalledWith('token', 'run-9', 'c1', expect.any(Object));
    });

    test('a reloaded conversation shows a failed turn as failed, with no reattach', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue(failedConversation);
        const { reattachRun } = require('../../services/reattachRunService');

        const { getByTestId } = renderProbe();
        await act(async () => { getByTestId('load').click(); });

        await waitFor(() => expect(getByTestId('error')).toHaveTextContent(LOST));
        expect(getByTestId('loading')).toHaveTextContent('false');
        expect(reattachRun).not.toHaveBeenCalled();
    });
});
