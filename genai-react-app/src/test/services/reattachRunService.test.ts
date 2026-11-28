import { reattachRun } from '../../services/reattachRunService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';

jest.mock('../../utils/apiUtils');
const mockFetch = fetchWithRetry as jest.Mock;

describe('reattachRunService', () => {
    beforeEach(() => jest.clearAllMocks());

    test('streams run frames into the callbacks and calls the reattach endpoint', async () => {
        const enc = new TextEncoder();
        const reader = {
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: enc.encode('{"t":"c","v":"Hi"}\n') })
                .mockResolvedValueOnce({ done: false, value: enc.encode('{"t":"ai","v":{"prompt":"Approve?","run_id":"r1"}}\n') })
                .mockResolvedValueOnce({ done: false, value: enc.encode('{"t":"done","status":"ok"}\n') })
                .mockResolvedValueOnce({ done: true }),
            releaseLock: jest.fn(),
        };
        mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Map(), body: { getReader: () => reader } });

        const onDelta = jest.fn();
        const onAwaitingInput = jest.fn();
        await reattachRun('tok', 'r1', 'c1', { onDelta, onAwaitingInput }, 5);

        expect(mockFetch).toHaveBeenCalledWith(
            endpoints.reattachRun('r1', 'c1', 5),
            expect.objectContaining({ method: HttpMethod.GET, headers: { Authorization: 'Bearer tok' } })
        );
        expect(onDelta).toHaveBeenCalledWith('Hi');
        expect(onAwaitingInput).toHaveBeenCalledWith({ prompt: 'Approve?', run_id: 'r1' });
        expect(reader.releaseLock).toHaveBeenCalled();
    });

    test('resolves false on a 404: the run is over and its reply saved', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404 });
        const onDelta = jest.fn();
        await expect(reattachRun('t', 'r', 'c', { onDelta })).resolves.toBe(false);
        expect(onDelta).not.toHaveBeenCalled();
    });

    test('throws on other non-ok responses', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        await expect(reattachRun('t', 'r', 'c', { onDelta: jest.fn() })).rejects.toThrow('Reattach failed: 500');
    });
});
