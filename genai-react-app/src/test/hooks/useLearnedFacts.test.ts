import { renderHook, act, waitFor } from '@testing-library/react';
import {
    useLearnedFacts,
    LEARNED_FACTS_POLL_INTERVAL_MS,
    LEARNED_FACTS_POLL_TIMEOUT_MS,
} from '../../hooks/useLearnedFacts';
import { getLearnedFacts, deleteMemoryFact } from '../../services/learnedFactsService';

jest.mock('../../services/learnedFactsService');
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({ getAccessTokenSilently: jest.fn().mockResolvedValue('tok') }),
}));

const mockGetLearnedFacts = getLearnedFacts as jest.Mock;
const mockDeleteMemoryFact = deleteMemoryFact as jest.Mock;

const FACTS = [
    { memoryId: 'mem-1', text: 'Prefers dark mode' },
    { memoryId: 'mem-2', text: 'Works in fintech' },
];

/** Flush pending microtasks (resolved promises) inside act. */
const flush = async () => act(async () => { await Promise.resolve(); });

describe('useLearnedFacts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('historical message with facts renders done immediately, no polling', async () => {
        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', FACTS, false)
        );

        expect(result.current.status).toBe('done');
        expect(result.current.facts).toEqual(FACTS);
        await flush();
        expect(mockGetLearnedFacts).not.toHaveBeenCalled();
    });

    test('historical message with null facts (unknown) is done-empty, no polling', async () => {
        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', null, false)
        );

        expect(result.current.status).toBe('done');
        expect(result.current.facts).toEqual([]);
        await flush();
        expect(mockGetLearnedFacts).not.toHaveBeenCalled();
    });

    test('fresh response polls until done and surfaces the facts', async () => {
        mockGetLearnedFacts
            .mockResolvedValueOnce({ status: 'pending', facts: [] })
            .mockResolvedValueOnce({ status: 'pending', facts: [] })
            .mockResolvedValueOnce({ status: 'done', facts: FACTS });

        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', undefined, true)
        );

        expect(result.current.status).toBe('pending');
        await flush(); // first (immediate) poll: pending
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('pending');

        await act(async () => { jest.advanceTimersByTime(LEARNED_FACTS_POLL_INTERVAL_MS); });
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(2);
        expect(result.current.status).toBe('pending');

        await act(async () => { jest.advanceTimersByTime(LEARNED_FACTS_POLL_INTERVAL_MS); });
        await waitFor(() => expect(result.current.status).toBe('done'));
        expect(result.current.facts).toEqual(FACTS);

        // Polling has stopped — no further requests after more time passes
        await act(async () => { jest.advanceTimersByTime(5 * LEARNED_FACTS_POLL_INTERVAL_MS); });
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(3);
    });

    test('keeps polling through transient fetch errors', async () => {
        mockGetLearnedFacts
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ status: 'done', facts: FACTS });

        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', undefined, true)
        );

        await flush(); // first poll fails
        expect(result.current.status).toBe('pending');

        await act(async () => { jest.advanceTimersByTime(LEARNED_FACTS_POLL_INTERVAL_MS); });
        await waitFor(() => expect(result.current.status).toBe('done'));
        expect(result.current.facts).toEqual(FACTS);
    });

    test('settles on done with no facts after the poll timeout', async () => {
        mockGetLearnedFacts.mockResolvedValue({ status: 'pending', facts: [] });

        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', undefined, true)
        );

        await flush();
        const attempts = Math.ceil(LEARNED_FACTS_POLL_TIMEOUT_MS / LEARNED_FACTS_POLL_INTERVAL_MS);
        for (let i = 0; i < attempts; i++) {
            await act(async () => { jest.advanceTimersByTime(LEARNED_FACTS_POLL_INTERVAL_MS); });
        }

        await waitFor(() => expect(result.current.status).toBe('done'));
        expect(result.current.facts).toEqual([]);

        const callsAtTimeout = mockGetLearnedFacts.mock.calls.length;
        await act(async () => { jest.advanceTimersByTime(5 * LEARNED_FACTS_POLL_INTERVAL_MS); });
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(callsAtTimeout);
    });

    test('stops polling on unmount', async () => {
        mockGetLearnedFacts.mockResolvedValue({ status: 'pending', facts: [] });

        const { unmount } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', undefined, true)
        );

        await flush();
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(1);

        unmount();
        await act(async () => { jest.advanceTimersByTime(5 * LEARNED_FACTS_POLL_INTERVAL_MS); });
        expect(mockGetLearnedFacts).toHaveBeenCalledTimes(1);
    });

    test('does not poll without a conversation id', async () => {
        const { result } = renderHook(() =>
            useLearnedFacts('', 'msg-1', undefined, true)
        );

        expect(result.current.status).toBe('done');
        await flush();
        expect(mockGetLearnedFacts).not.toHaveBeenCalled();
    });

    test('removeFact deletes and drops the fact from the list', async () => {
        mockDeleteMemoryFact.mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', FACTS, false)
        );

        await act(async () => { await result.current.removeFact('mem-1'); });

        expect(mockDeleteMemoryFact).toHaveBeenCalledWith('tok', 'mem-1');
        expect(result.current.facts).toEqual([FACTS[1]]);
    });

    test('removeFact keeps the fact when the delete really fails', async () => {
        mockDeleteMemoryFact.mockRejectedValue(new Error('HTTP 500'));

        const { result } = renderHook(() =>
            useLearnedFacts('conv-1', 'msg-1', FACTS, false)
        );

        await act(async () => {
            await expect(result.current.removeFact('mem-1')).rejects.toThrow('HTTP 500');
        });

        expect(result.current.facts).toEqual(FACTS);
    });
});
