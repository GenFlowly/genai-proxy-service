import { cancelGeneration } from '../../services/cancelGenerationService';
import { fetchWithRetry } from '../../utils/apiUtils';

jest.mock('../../utils/apiUtils');

const mockedFetchWithRetry = fetchWithRetry as jest.MockedFunction<typeof fetchWithRetry>;

describe('cancelGeneration', () => {
    afterEach(() => jest.resetAllMocks());

    test('POSTs the generation id with auth and retries enabled', async () => {
        mockedFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({ cancelled: true }),
        } as unknown as Response);

        await expect(cancelGeneration('tok', 'gen-123')).resolves.toBe(true);

        const [url, options] = mockedFetchWithRetry.mock.calls[0];
        expect(url).toContain('/generations/cancel?responseMessageId=gen-123');
        expect(options).toMatchObject({
            method: 'POST',
            headers: { Authorization: 'Bearer tok' },
        });
        // An unacknowledged cancel keeps the model generating and billing —
        // transient failures must be retried, not fired-and-forgotten.
        expect(options?.retries).toBeGreaterThan(0);
    });

    test('returns false when the server reports nothing was running', async () => {
        mockedFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({ cancelled: false }),
        } as unknown as Response);
        await expect(cancelGeneration('tok', 'gen-404')).resolves.toBe(false);
    });

    test('throws on a non-ok response', async () => {
        mockedFetchWithRetry.mockResolvedValue({
            ok: false,
            statusText: 'Internal Server Error',
        } as unknown as Response);
        await expect(cancelGeneration('tok', 'gen-500')).rejects.toThrow('Failed to cancel generation');
    });
});
