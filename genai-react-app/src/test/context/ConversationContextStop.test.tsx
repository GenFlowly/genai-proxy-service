import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { generateTextStream } from '../../services/generateTextStreamService';
import { cancelGeneration } from '../../services/cancelGenerationService';
import { createConversationTitle } from '../../services/createConversationTitleService';

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        customerId: 'user123',
        isAuthenticated: true,
        isSessionAuthenticated: true,
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}));

let mockConfig: { aiVendor: string; model: string }[] = [];
jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: mockConfig,
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
const mockCancel = cancelGeneration as jest.Mock;
const mockCreateTitle = createConversationTitle as jest.Mock;

let latest: any = null;
let context: any = null;
const Tester = () => {
    const conversation = useConversation();
    latest = conversation.conversationBlockList[0];
    context = conversation;
    return (
        <div>
            <button data-testid="stream" onClick={() => conversation.generateResponsesStream('conv-default')}>stream</button>
            <button data-testid="stop" onClick={() => conversation.stopGenerating('conv-default', 'OPENAI')}>stop</button>
        </div>
    );
};

const renderTester = () => render(<MemoryRouter><ConversationProvider><Tester /></ConversationProvider></MemoryRouter>);

/** A stream that delivers what [deliver] sends, then runs until it is aborted. */
const streamUntilAborted = (deliver: (args: any[]) => void) => {
    mockGenerate.mockImplementation((...args: any[]) => {
        args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' });
        deliver(args);
        const signal: AbortSignal | undefined = args[5];
        return new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
        });
    });
};

const stop = async (getByTestId: (id: string) => HTMLElement) => {
    await act(async () => { getByTestId('stream').click(); });
    await act(async () => {});
    await act(async () => { getByTestId('stop').click(); });
    await act(async () => {});
};

const abortError = () => new DOMException('The user aborted a request.', 'AbortError');

/** One generate request: answers only when the test sends its headers / ends it. */
interface PendingStream {
    request: any;
    signal: AbortSignal;
    sendHeaders: (conversationId: string) => void;
    deliver: (text: string) => void;
    end: () => void;
}

/** Records every generate request and leaves each one waiting on the test. */
const recordStreams = (): PendingStream[] => {
    const streams: PendingStream[] = [];
    mockGenerate.mockImplementation((...args: any[]) => {
        const signal: AbortSignal = args[5];
        return new Promise<void>((resolve, reject) => {
            if (signal.aborted) return reject(abortError());
            signal.addEventListener('abort', () => reject(abortError()));
            streams.push({
                request: args[1],
                signal,
                sendHeaders: conversationId => args[3]?.({ conversationId, responseMessageId: `rm-${args[1].aiConfig.aiVendor}` }),
                deliver: text => args[2]?.(text),
                end: resolve,
            });
        });
    });
    return streams;
};

const reply = (vendor: string) => latest.responseMessages.find((m: any) => m.aiVendor === vendor);

/** The starter's headers open the conversation; the other vendors launch 200ms later. */
const sendHeadersAndLaunchTheRest = async (stream: PendingStream, conversationId: string) => {
    await act(async () => { stream.sendHeaders(conversationId); });
    await act(async () => { await new Promise(r => setTimeout(r, 250)); });
};

describe('ConversationContext Stop', () => {
    beforeEach(() => {
        mockConfig = [{ aiVendor: 'OPENAI', model: 'gpt-5.4-nano' }];
        mockCreateTitle.mockResolvedValue({ title: 'A title' });
        mockCancel.mockResolvedValue(true);
    });

    test('keeps the streamed text and marks the reply stopped', async () => {
        streamUntilAborted(args => args[2]?.('partial answer'));
        const { getByTestId } = renderTester();

        await stop(getByTestId);

        const [reply] = latest.responseMessages;
        expect(reply).toMatchObject({ messageId: 'rm1', text: 'partial answer', isLoading: false, stopReason: 'cancelled' });
        expect(reply.error).toBeUndefined();
        expect(latest.isLoading).toBe(false);
        expect(mockCancel).toHaveBeenCalledWith('token', expect.any(String));
    });

    test('a reply stopped while thinking keeps its card, activity log and stop reason', async () => {
        const stepStart = { v: 2, at: 40, type: 'step.start', id: 'n1:1', kind: 'llm', node: 'n1', name: 'Response Generator' };
        streamUntilAborted(args => args[4]?.(stepStart));
        const { getByTestId } = renderTester();

        await stop(getByTestId);

        const [reply] = latest.responseMessages;
        expect(reply).toMatchObject({ messageId: 'rm1', text: '', isLoading: false, stopReason: 'cancelled' });
        // The open step stays as streamed; the panel reads it as stopped from the stop reason.
        expect(reply.activity).toEqual([stepStart]);
    });

    describe('a new chat with several vendors', () => {
        beforeEach(() => {
            mockConfig = [
                { aiVendor: 'OPENAI', model: 'gpt-5.4-nano' },
                { aiVendor: 'CLAUDE', model: 'claude-haiku-5-5' },
            ];
        });

        test('stopping the first vendor before its headers keeps one conversation', async () => {
            const streams = recordStreams();
            const { getByTestId } = renderTester();
            await act(async () => { getByTestId('stream').click(); });
            expect(streams).toHaveLength(1);

            await act(async () => { context.stopGenerating('conv-default', 'OPENAI'); });

            expect(reply('OPENAI')).toMatchObject({ isLoading: false, stopReason: 'cancelled' });
            expect(mockCancel).toHaveBeenCalledWith('token', streams[0].request.generationId);
            expect(streams[0].signal.aborted).toBe(false);

            await sendHeadersAndLaunchTheRest(streams[0], 'c1');

            expect(streams[0].signal.aborted).toBe(true);
            expect(streams).toHaveLength(2);
            expect(streams[1].request).toMatchObject({ conversationId: 'c1', aiConfig: { aiVendor: 'CLAUDE' } });
            expect(streams.filter(s => !s.request.conversationId)).toHaveLength(1);

            await act(async () => { streams[1].sendHeaders('c1'); streams[1].deliver('answer'); streams[1].end(); });
            expect(reply('CLAUDE')).toMatchObject({ text: 'answer', isLoading: false });
            expect(reply('CLAUDE').stopReason).toBeUndefined();
            expect(reply('OPENAI')).toMatchObject({ isLoading: false, stopReason: 'cancelled' });
        });

        test('a vendor stopped before it launches joins the conversation, stopped', async () => {
            const streams = recordStreams();
            const { getByTestId } = renderTester();
            await act(async () => { getByTestId('stream').click(); });

            await act(async () => { context.stopGenerating('conv-default', 'CLAUDE'); });
            expect(reply('CLAUDE')).toMatchObject({ isLoading: false, stopReason: 'cancelled' });
            const cancelledId = mockCancel.mock.calls[0][1];

            await sendHeadersAndLaunchTheRest(streams[0], 'c1');

            expect(streams[1].request).toMatchObject({ conversationId: 'c1', generationId: cancelledId, aiConfig: { aiVendor: 'CLAUDE' } });
            expect(streams[1].signal.aborted).toBe(false);
            await act(async () => { streams[1].sendHeaders('c1'); });
            expect(streams[1].signal.aborted).toBe(true);

            await act(async () => { streams[0].deliver('answer'); streams[0].end(); });
            expect(reply('OPENAI')).toMatchObject({ text: 'answer', isLoading: false });
            expect(reply('CLAUDE')).toMatchObject({ isLoading: false, stopReason: 'cancelled' });
            expect(latest.isLoading).toBe(false);
        });

        test('a stopped first vendor whose headers never come starts no second conversation', async () => {
            jest.useFakeTimers();
            try {
                const streams = recordStreams();
                const { getByTestId } = renderTester();
                await act(async () => { getByTestId('stream').click(); });
                await act(async () => { context.stopGenerating('conv-default', 'OPENAI'); });

                await act(async () => { jest.advanceTimersByTime(30_000); });
                await act(async () => { jest.runOnlyPendingTimers(); });

                expect(streams[0].signal.aborted).toBe(true);
                expect(streams).toHaveLength(1);
                expect(reply('CLAUDE')).toMatchObject({ isLoading: false, stopReason: 'cancelled' });
                expect(latest.isLoading).toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        test('Regenerate waits until the stopped request is over', async () => {
            const streams = recordStreams();
            const { getByTestId } = renderTester();
            await act(async () => { getByTestId('stream').click(); });
            await act(async () => { context.stopGenerating('conv-default', 'OPENAI'); });

            await act(async () => { context.generateResponsesStream('conv-default', undefined, undefined, 'OPENAI'); });

            expect(streams).toHaveLength(1);
        });
    });
});
