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

jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: [{ aiVendor: 'OPENAI', model: 'gpt-5.4-nano' }],
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
const Tester = () => {
    const conversation = useConversation();
    latest = conversation.conversationBlockList[0];
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

describe('ConversationContext Stop', () => {
    beforeEach(() => {
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

    test('a reply stopped while thinking keeps its card, steps and stop reason', async () => {
        streamUntilAborted(args => args[8]?.({ node: 'n1', name: 'Response Generator', status: 'running' }));
        const { getByTestId } = renderTester();

        await stop(getByTestId);

        const [reply] = latest.responseMessages;
        expect(reply).toMatchObject({ messageId: 'rm1', text: '', isLoading: false, stopReason: 'cancelled' });
        expect(reply.thinkingStepList).toEqual([expect.objectContaining({ node: 'n1', status: 'done' })]);
    });
});
