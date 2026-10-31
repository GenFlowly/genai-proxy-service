import { fetchWithRetry } from '../../utils/apiUtils';

describe('fetchWithRetry', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
        // Use real timers with small backoff for reliable testing of async flows
        jest.useRealTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it('should return response immediately on success (200 OK)', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ data: 'success' }),
        });

        const response = await fetchWithRetry('https://api.example.com/data');
        expect(response.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on non-retryable error status (e.g., 404)', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 404,
        });

        const response = await fetchWithRetry('https://api.example.com/data');
        expect(response.status).toBe(404);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable status codes (e.g., 500)', async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({ ok: false, status: 500 }) // Fail 1
            .mockResolvedValueOnce({ ok: false, status: 500 }) // Fail 2
            .mockResolvedValueOnce({ ok: true, status: 200 }); // Success 3

        const promise = fetchWithRetry('https://api.example.com/data', { retries: 3, backoff: 1 });

        const response = await promise;
        expect(response.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should exhaust retries and return last response if all fail', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 503,
        });

        const promise = fetchWithRetry('https://api.example.com/data', { retries: 2, backoff: 1 });

        const response = await promise;
        expect(response.status).toBe(503);
        expect(global.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should retry on network errors (fetch throws)', async () => {
        (global.fetch as jest.Mock)
            .mockRejectedValueOnce(new Error('Network Error'))
            .mockResolvedValueOnce({ ok: true, status: 200 });

        const promise = fetchWithRetry('https://api.example.com/data', { retries: 2, backoff: 1 });

        const response = await promise;
        expect(response.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should throw error if retries exhausted on network error', async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error('Persistent Network Error'));

        const promise = fetchWithRetry('https://api.example.com/data', { retries: 2, backoff: 1 });

        await expect(promise).rejects.toThrow('Persistent Network Error');
        expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry on 403 Forbidden', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 403,
        });

        const response = await fetchWithRetry('https://api.example.com/data', { retries: 3, backoff: 1 });
        expect(response.status).toBe(403);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry a deliberate abort (AbortError rethrows immediately)', async () => {
        // Re-issuing an aborted request would restart the very generation the
        // user just stopped (and bill for it) — the abort must surface at once.
        const abortError: any = new Error('The user aborted a request.');
        abortError.name = 'AbortError';
        (global.fetch as jest.Mock).mockRejectedValue(abortError);

        const promise = fetchWithRetry('https://api.example.com/data', { retries: 3, backoff: 1 });

        await expect(promise).rejects.toBe(abortError);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry when the provided signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        (global.fetch as jest.Mock).mockRejectedValue(new TypeError('aborted'));

        const promise = fetchWithRetry('https://api.example.com/data', {
            retries: 3,
            backoff: 1,
            signal: controller.signal,
        });

        await expect(promise).rejects.toThrow();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
// Trigger coverage run
// Trigger coverage run
