import { followRun, isNetworkLoss, newRunCursor, ReplyRecoveryFailed, turnClockEvent } from '../../services/followRunService';
import { reattachRun } from '../../services/reattachRunService';
import { StreamGenerationError, StreamTruncatedError } from '../../services/generateTextStreamService';
import { isActivityEvent } from '@genflowly/component-library';

jest.mock('../../services/reattachRunService');

const mockReattach = reattachRun as jest.MockedFunction<typeof reattachRun>;
const token = () => Promise.resolve('t');
const callbacks = { onDelta: jest.fn() };

describe('followRun', () => {
    const noWait = () => 0;
    beforeEach(() => mockReattach.mockReset());

    test('reattaches after the last event applied, not from the start', async () => {
        mockReattach.mockResolvedValue(true);
        const cursor = { ...newRunCursor('run_1'), lastSeq: 41 };
        await followRun(token, cursor, 'c1', callbacks);
        expect(mockReattach).toHaveBeenCalledWith('t', 'run_1', 'c1', callbacks, 41, undefined);
        expect(cursor.active).toBe(true);
    });

    test('a run already over leaves the cursor inactive', async () => {
        mockReattach.mockResolvedValue(false);
        const cursor = newRunCursor('run_1');
        await followRun(token, cursor, 'c1', callbacks);
        expect(cursor.active).toBe(false);
    });

    test('a dropped stream reconnects from wherever it got to', async () => {
        const cursor = newRunCursor('run_1');
        mockReattach
            .mockImplementationOnce(async () => { cursor.lastSeq = 7; throw new StreamTruncatedError('cut'); })
            .mockResolvedValueOnce(true);
        await followRun(token, cursor, 'c1', callbacks, undefined, noWait);
        expect(mockReattach).toHaveBeenNthCalledWith(2, 't', 'run_1', 'c1', callbacks, 7, undefined);
        expect(mockReattach).toHaveBeenCalledTimes(2);
    });

    test('gives up after five failures while the server was reachable', async () => {
        mockReattach.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(followRun(token, newRunCursor('run_1'), 'c1', callbacks, undefined, noWait))
            .rejects.toBeInstanceOf(ReplyRecoveryFailed);
        expect(mockReattach).toHaveBeenCalledTimes(5);
    });

    test('waits while the tab is hidden, then resumes on return', async () => {
        const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        mockReattach.mockResolvedValue(true);
        const done = followRun(token, newRunCursor('run_1'), 'c1', callbacks);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(mockReattach).not.toHaveBeenCalled();
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await done;
        expect(mockReattach).toHaveBeenCalledTimes(1);
        visibility.mockRestore();
    });

    test("the server's verdict ends it without retrying", async () => {
        mockReattach.mockRejectedValue(new StreamGenerationError('quota'));
        await expect(followRun(token, newRunCursor('run_1'), 'c1', callbacks)).rejects.toBeInstanceOf(StreamGenerationError);
        expect(mockReattach).toHaveBeenCalledTimes(1);
    });

    test('Stop aborts a wait between attempts', async () => {
        mockReattach.mockRejectedValue(new TypeError('Failed to fetch'));
        const controller = new AbortController();
        const done = followRun(token, newRunCursor('run_1'), 'c1', callbacks, controller.signal, () => 60_000);
        const settled = expect(done).rejects.toMatchObject({ name: 'AbortError' });
        await new Promise(resolve => setTimeout(resolve, 20));
        controller.abort();
        await settled;
        expect(mockReattach).toHaveBeenCalledTimes(1);
    });
});

describe('isNetworkLoss', () => {
    test('a dropped connection is not a fault', () => {
        expect(isNetworkLoss(new TypeError('Failed to fetch'))).toBe(true);
        expect(isNetworkLoss(new StreamTruncatedError('cut'))).toBe(true);
    });
    test('real failures still count', () => {
        expect(isNetworkLoss(new StreamGenerationError('quota'))).toBe(false);
        expect(isNetworkLoss(new ReplyRecoveryFailed(new TypeError('x')))).toBe(false);
    });
});

describe('turnClockEvent', () => {
    test('carries the clock but is never a step', () => {
        const event = turnClockEvent(41250);
        expect((event as { at: number }).at).toBe(41250);
        expect(isActivityEvent(event)).toBe(false);
    });
});
