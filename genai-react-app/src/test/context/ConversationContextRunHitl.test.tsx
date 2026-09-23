import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationProvider, useConversation, useRunHitl } from '../../context/ConversationContext';

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

const HitlTester = () => {
    const conv = useConversation();
    const { awaitingInputs, submitRunReply } = useRunHitl();
    const keys = Object.keys(awaitingInputs);
    return (
        <div>
            <div data-testid="await-count">{keys.length}</div>
            <div data-testid="await-prompt">{keys[0] ? String((awaitingInputs[keys[0]] as any).prompt) : ''}</div>
            <button data-testid="stream-btn" onClick={() => conv.generateResponsesStream('conv-default')}>stream</button>
            <button data-testid="reply-btn" onClick={() => { if (keys[0]) submitRunReply(keys[0], 'yes'); }}>reply</button>
        </div>
    );
};

const LoadTester = () => {
    const conv = useConversation();
    return (
        <div>
            <div data-testid="text">{conv.conversationBlockList[0]?.responseMessages[0]?.text ?? ''}</div>
            <button data-testid="load" onClick={() => conv.loadConversation('c1')}>load</button>
        </div>
    );
};

describe('ConversationContext durable-run HITL', () => {
    beforeEach(() => jest.clearAllMocks());

    test('sets awaitingInputs on an "ai" frame and resumes the run on reply', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((...args: any[]) => {
            const onMetadata = args[3];
            const onAwaitingInput = args[10];
            onMetadata?.({ conversationId: 'c1', messageId: 'm1', responseMessageId: 'rm1' });
            onAwaitingInput?.({ type: 'human_input', prompt: 'Approve?', run_id: 'run-1' });
            // The run is paused awaiting input — the live stream stays open.
            return new Promise(() => { /* never resolves */ });
        });
        const { resumeRun } = require('../../services/resumeRunService');
        resumeRun.mockResolvedValue(true);

        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><HitlTester /></ConversationProvider></MemoryRouter>
        );

        await act(async () => { getByTestId('stream-btn').click(); });
        await waitFor(() => expect(getByTestId('await-count')).toHaveTextContent('1'));
        expect(getByTestId('await-prompt')).toHaveTextContent('Approve?');

        await act(async () => { getByTestId('reply-btn').click(); });
        await waitFor(() =>
            expect(resumeRun).toHaveBeenCalledWith('token', 'run-1', expect.any(String), { reply: 'yes' })
        );
    });

    test('reattaches to a pending run on conversation load', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{
                conversationBlockId: 'b1',
                prompt: { prompt: 'hi' },
                responseMessages: [{ messageId: 'm1', text: 'partial', isLoading: false }],
            }],
            role: 'OWNER', title: null, instructionId: null, pendingRunId: 'run-9',
        });
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_token: any, _runId: any, _convId: any, cb: any) => {
            cb.onDelta('resumed');
            return Promise.resolve();
        });

        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><LoadTester /></ConversationProvider></MemoryRouter>
        );

        await act(async () => { getByTestId('load').click(); });
        await waitFor(() =>
            expect(reattachRun).toHaveBeenCalledWith('token', 'run-9', 'c1', expect.any(Object))
        );
        await waitFor(() => expect(getByTestId('text')).toHaveTextContent('resumed'));
    });

    test('reattaches and synthesizes a placeholder when the in-flight turn has no persisted response', async () => {
        // The real reload-mid-run case: the proxy has persisted the user turn and
        // the pendingRunId, but NOT the assistant message yet (it writes that only
        // when the run finishes) — so the last block comes back with an empty
        // responseMessages array. Reattach must still fire and stream into a
        // synthesized placeholder, otherwise the block shows "No responses were
        // generated".
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{
                conversationBlockId: 'b1',
                prompt: { prompt: 'hi' },
                responseMessages: [],
            }],
            role: 'OWNER', title: null, instructionId: null, pendingRunId: 'run-9',
        });
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_token: any, _runId: any, _convId: any, cb: any) => {
            cb.onDelta('recovered');
            return Promise.resolve();
        });

        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><LoadTester /></ConversationProvider></MemoryRouter>
        );
        await act(async () => { getByTestId('load').click(); });
        await waitFor(() =>
            expect(reattachRun).toHaveBeenCalledWith('token', 'run-9', 'c1', expect.any(Object))
        );
        await waitFor(() => expect(getByTestId('text')).toHaveTextContent('recovered'));
    });

    test('reattaches to the backend in-flight placeholder and fills in usage/cost', async () => {
        // The proxy now surfaces an in-flight placeholder with the real,
        // deterministic responseMessageId (mapped to isLoading via inFlight). The
        // client attaches to it, streams the reply, then fetches usage by that id.
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{
                conversationBlockId: 'b1',
                prompt: { prompt: 'hi' },
                responseMessages: [{ messageId: 'real-rm', aiVendor: 'OPENAI', text: '', isLoading: true }],
            }],
            role: 'OWNER', title: null, instructionId: null, pendingRunId: 'run-9',
        });
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_t: any, _r: any, _c: any, cb: any) => {
            cb.onDelta('streamed answer');
            return Promise.resolve();
        });
        const { getAIUsageActivity } = require('../../services/getAIUsageService');
        getAIUsageActivity.mockResolvedValue({ inputTokens: 11, outputTokens: 22, totalTokens: 33, costUsd: 0.01 });

        const Comp = () => {
            const c = useConversation();
            const m = c.conversationBlockList[0]?.responseMessages[0];
            return (
                <div>
                    <div data-testid="text">{m?.text ?? ''}</div>
                    <div data-testid="tokens">{m?.totalTokens ?? ''}</div>
                    <button data-testid="load" onClick={() => c.loadConversation('c1')}>load</button>
                </div>
            );
        };
        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>
        );
        await act(async () => { getByTestId('load').click(); });
        await waitFor(() => expect(reattachRun).toHaveBeenCalledWith('token', 'run-9', 'c1', expect.any(Object)));
        await waitFor(() => expect(getByTestId('text')).toHaveTextContent('streamed answer'));
        await waitFor(() => expect(getAIUsageActivity).toHaveBeenCalledWith('token', 'c1', 'real-rm'));
        await waitFor(() => expect(getByTestId('tokens')).toHaveTextContent('33'));
    });

    test('reattaches to every vendor run on a multi-vendor reload', async () => {
        // A multi-vendor turn fans out to one durable run per vendor; the proxy
        // surfaces one in-flight placeholder each (own runId), and the client must
        // reattach to ALL of them — not just the last (the original bug).
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{
                conversationBlockId: 'b1',
                prompt: { prompt: 'hi' },
                responseMessages: [
                    { messageId: 'rm-openai', aiVendor: 'OPENAI', text: '', isLoading: true },
                    { messageId: 'rm-claude', aiVendor: 'CLAUDE', text: '', isLoading: true },
                ],
            }],
            role: 'OWNER', title: null, instructionId: null,
            pendingRunId: 'run-openai',
            pendingRuns: [
                { messageId: 'rm-openai', runId: 'run-openai' },
                { messageId: 'rm-claude', runId: 'run-claude' },
            ],
        });
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_t: any, runId: any, _c: any, cb: any) => {
            cb.onDelta(runId === 'run-openai' ? 'openai answer' : 'claude answer');
            return Promise.resolve();
        });
        const { getAIUsageActivity } = require('../../services/getAIUsageService');
        getAIUsageActivity.mockResolvedValue({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

        const Comp = () => {
            const c = useConversation();
            const msgs = c.conversationBlockList[0]?.responseMessages ?? [];
            return (
                <div>
                    <div data-testid="t0">{msgs[0]?.text ?? ''}</div>
                    <div data-testid="t1">{msgs[1]?.text ?? ''}</div>
                    <button data-testid="load" onClick={() => c.loadConversation('c1')}>load</button>
                </div>
            );
        };
        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>
        );
        await act(async () => { getByTestId('load').click(); });
        await waitFor(() => expect(reattachRun).toHaveBeenCalledWith('token', 'run-openai', 'c1', expect.any(Object)));
        await waitFor(() => expect(reattachRun).toHaveBeenCalledWith('token', 'run-claude', 'c1', expect.any(Object)));
        await waitFor(() => expect(getByTestId('t0')).toHaveTextContent('openai answer'));
        await waitFor(() => expect(getByTestId('t1')).toHaveTextContent('claude answer'));
    });

    test('does not reattach when there is no pending run', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{ conversationBlockId: 'b1', prompt: { prompt: 'hi' }, responseMessages: [{ messageId: 'm1', text: 'done', isLoading: false }] }],
            role: 'OWNER', title: null, instructionId: null, pendingRunId: null,
        });
        const { reattachRun } = require('../../services/reattachRunService');

        const { getByTestId } = render(
            <MemoryRouter><ConversationProvider><LoadTester /></ConversationProvider></MemoryRouter>
        );
        await act(async () => { getByTestId('load').click(); });
        await waitFor(() => expect(getByTestId('text')).toHaveTextContent('done'));
        expect(reattachRun).not.toHaveBeenCalled();
    });

    test('reattach applies thinking / web-source / attachment / awaiting-input frames', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue({
            conversationId: 'c1',
            blocks: [{ conversationBlockId: 'b1', prompt: { prompt: 'hi' }, responseMessages: [{ messageId: 'm1', text: '', isLoading: false }] }],
            role: 'OWNER', title: 'T', instructionId: 'i1', pendingRunId: 'run-9',
        });
        const { reattachRun } = require('../../services/reattachRunService');
        reattachRun.mockImplementation((_t: any, _r: any, _c: any, cb: any) => {
            cb.onDelta('a');
            cb.onThinkingStep?.({ node: 'n', name: 'N', kind: 'LLM', status: 'running' });
            cb.onThinkingDuration?.(123);
            cb.onWebSources?.([{ index: 1, title: 't', url: 'u' }]);
            cb.onGeneratedAttachments?.([{ attachmentId: 'x', s3Key: 'k', mediaType: 'application/pdf' }]);
            cb.onAwaitingInput?.({ prompt: 'P' });
            return Promise.resolve();
        });

        const Comp = () => {
            const c = useConversation();
            const { awaitingInputs } = useRunHitl();
            return (
                <div>
                    <div data-testid="txt">{c.conversationBlockList[0]?.responseMessages[0]?.text ?? ''}</div>
                    <div data-testid="aw">{Object.keys(awaitingInputs).length}</div>
                    <button data-testid="l" onClick={() => c.loadConversation('c1')}>l</button>
                </div>
            );
        };
        const { getByTestId } = render(<MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>);
        await act(async () => { getByTestId('l').click(); });
        await waitFor(() => expect(getByTestId('txt')).toHaveTextContent('a'));
        await waitFor(() => expect(getByTestId('aw')).toHaveTextContent('1'));
    });

    test('submitRunReply no-ops without a run id, and toasts when resume fails', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        const { resumeRun } = require('../../services/resumeRunService');

        // Case 1: awaiting frame WITHOUT a run_id -> submitRunReply returns early.
        generateTextStream.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' });
            args[10]?.({ prompt: 'need input' }); // no run_id
            return new Promise(() => {});
        });
        const { getByTestId, unmount } = render(
            <MemoryRouter><ConversationProvider><HitlTester /></ConversationProvider></MemoryRouter>
        );
        await act(async () => { getByTestId('stream-btn').click(); });
        await waitFor(() => expect(getByTestId('await-count')).toHaveTextContent('1'));
        await act(async () => { getByTestId('reply-btn').click(); });
        expect(resumeRun).not.toHaveBeenCalled();
        unmount();

        // Case 2: run_id present but resume returns false -> reply still clears + no throw.
        jest.clearAllMocks();
        generateTextStream.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c2', responseMessageId: 'rm2' });
            args[10]?.({ prompt: 'need input', run_id: 'run-2' });
            return new Promise(() => {});
        });
        resumeRun.mockResolvedValue(false);
        const two = render(<MemoryRouter><ConversationProvider><HitlTester /></ConversationProvider></MemoryRouter>);
        await act(async () => { two.getByTestId('stream-btn').click(); });
        await waitFor(() => expect(two.getByTestId('await-count')).toHaveTextContent('1'));
        await act(async () => { two.getByTestId('reply-btn').click(); });
        await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('token', 'run-2', expect.any(String), { reply: 'yes' }));
    });

    test('generateResponsesStream keeps partial text on a mid-stream failure', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((...args: any[]) => {
            args[2]?.('partial ');
            args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' });
            return Promise.reject(new Error('provider exploded'));
        });
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockResolvedValue(null); // recovery finds nothing

        const Comp = () => {
            const c = useConversation();
            return (
                <div>
                    <div data-testid="t">{c.conversationBlockList[0]?.responseMessages[0]?.text ?? ''}</div>
                    <button data-testid="s" onClick={() => c.generateResponsesStream('conv-default')}>s</button>
                </div>
            );
        };
        const { getByTestId } = render(<MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>);
        await act(async () => { getByTestId('s').click(); });
        await waitFor(() => expect(getByTestId('t')).toHaveTextContent('partial'));
    });

    test('stream fans every frame type across multiple blocks', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        generateTextStream.mockImplementation((...args: any[]) => {
            const onDelta = args[2];
            const onMetadata = args[3];
            const onThinking = args[4];
            const onThinkingDuration = args[6];
            const onWebSources = args[7];
            const onThinkingStep = args[8];
            const onGeneratedAttachments = args[9];
            onThinking?.('thinking...');
            onThinkingStep?.({ node: 'n', name: 'N', kind: 'LLM', status: 'running' });
            onThinkingDuration?.(50);
            onWebSources?.([{ index: 1, title: 't', url: 'u' }]);
            onGeneratedAttachments?.([{ attachmentId: 'a', s3Key: 'k', mediaType: 'application/pdf' }]);
            onDelta('hello');
            onMetadata?.({ conversationId: 'c1', messageId: 'm1', responseMessageId: 'rm1' });
            onDelta(' world');
            return Promise.resolve();
        });

        const Comp = () => {
            const c = useConversation();
            return (
                <div>
                    <div data-testid="txt">{c.conversationBlockList[0]?.responseMessages[0]?.text ?? ''}</div>
                    <button data-testid="add" onClick={() => c.addNewConversationBlock()}>add</button>
                    <button data-testid="s" onClick={() => c.generateResponsesStream('conv-default')}>s</button>
                </div>
            );
        };
        const { getByTestId } = render(<MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>);
        await act(async () => { getByTestId('add').click(); }); // two blocks -> exercises the non-matching branch
        await act(async () => { getByTestId('s').click(); });
        await waitFor(() => expect(getByTestId('txt')).toHaveTextContent('hello world'));
    });

    test('stream cancels the run server-side on abort after metadata', async () => {
        const { generateTextStream } = require('../../services/generateTextStreamService');
        const { cancelGeneration } = require('../../services/cancelGenerationService');
        cancelGeneration.mockResolvedValue(true);
        generateTextStream.mockImplementation((...args: any[]) => {
            args[3]?.({ conversationId: 'c1', responseMessageId: 'rm1' }); // real id -> currentMsgId != placeholder
            const e: any = new Error('aborted');
            e.name = 'AbortError';
            return Promise.reject(e);
        });

        const Comp = () => {
            const c = useConversation();
            return <button data-testid="s" onClick={() => c.generateResponsesStream('conv-default')}>s</button>;
        };
        const { getByTestId } = render(<MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>);
        await act(async () => { getByTestId('s').click(); });
        await waitFor(() => expect(cancelGeneration).toHaveBeenCalledWith('token', 'rm1'));
    });

    test('conversation block + selection actions', async () => {
        const Comp = () => {
            const c = useConversation();
            return (
                <div>
                    <div data-testid="count">{c.conversationBlockList.length}</div>
                    <div data-testid="sel">{String(c.getSelectedResponseForBlock('b9'))}</div>
                    <div data-testid="ven">{JSON.stringify(c.getVendorSelectionForBlock('b9'))}</div>
                    <button data-testid="add" onClick={() => c.addNewConversationBlock('hi')}>add</button>
                    <button data-testid="addid" onClick={() => c.addNewConversationBlockWithId('bx', 'hey')}>addid</button>
                    <button data-testid="active" onClick={() => c.setActiveBlockId('b9')}>active</button>
                    <button data-testid="setsel" onClick={() => c.setSelectedResponseForBlock('b9', 'm1')}>setsel</button>
                    <button data-testid="setven" onClick={() => c.setVendorSelectionForBlock('b9', ['OPENAI'])}>setven</button>
                    <button data-testid="sys" onClick={() => c.setSystemPrompt('sp')}>sys</button>
                    <button data-testid="stop" onClick={() => c.stopGenerating('b9', 'OPENAI')}>stop</button>
                </div>
            );
        };
        const { getByTestId } = render(<MemoryRouter><ConversationProvider><Comp /></ConversationProvider></MemoryRouter>);
        await act(async () => {
            getByTestId('add').click();
            getByTestId('addid').click();
            getByTestId('active').click();
            getByTestId('setsel').click();
            getByTestId('setven').click();
            getByTestId('sys').click();
            getByTestId('stop').click();
        });
        await waitFor(() => expect(getByTestId('sel')).toHaveTextContent('m1'));
        expect(getByTestId('ven')).toHaveTextContent('OPENAI');
    });
});
