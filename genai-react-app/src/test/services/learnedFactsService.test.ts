import { getLearnedFacts, deleteMemoryFact } from '../../services/learnedFactsService';

describe('learnedFactsService', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.resetAllMocks();
    });

    const mockFetchResponse = (status: number, body: any = {}) => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            statusText: `HTTP ${status}`,
            json: async () => body,
        });
    };

    describe('getLearnedFacts', () => {
        test('calls the learned-facts endpoint with bearer auth', async () => {
            mockFetchResponse(200, { status: 'done', facts: [] });

            await getLearnedFacts('tok-123', 'conv-1', 'msg-1');

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/v1/conversation/learned-facts?conversationId=conv-1&messageId=msg-1'),
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }),
                })
            );
        });

        test('returns pending status while extraction is running', async () => {
            mockFetchResponse(200, { status: 'pending', facts: [] });

            const result = await getLearnedFacts('tok', 'conv-1', 'msg-1');

            expect(result).toEqual({ status: 'pending', facts: [] });
        });

        test('returns done status with the fact list', async () => {
            const facts = [
                { memoryId: 'mem-1', text: 'Prefers dark mode' },
                { memoryId: 'mem-2', text: 'Works in fintech' },
            ];
            mockFetchResponse(200, { status: 'done', facts });

            const result = await getLearnedFacts('tok', 'conv-1', 'msg-1');

            expect(result).toEqual({ status: 'done', facts });
        });

        test('normalizes a missing facts array to []', async () => {
            mockFetchResponse(200, { status: 'done' });

            const result = await getLearnedFacts('tok', 'conv-1', 'msg-1');

            expect(result).toEqual({ status: 'done', facts: [] });
        });

        test('throws on HTTP errors', async () => {
            mockFetchResponse(403);

            await expect(getLearnedFacts('tok', 'conv-1', 'msg-1')).rejects.toThrow(
                'Failed to fetch learned facts: 403'
            );
        });
    });

    describe('deleteMemoryFact', () => {
        test('DELETEs the memory with bearer auth', async () => {
            mockFetchResponse(200, {});

            await deleteMemoryFact('tok-123', 'mem-1');

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/v1/memories/mem-1'),
                expect.objectContaining({
                    method: 'DELETE',
                    headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }),
                })
            );
        });

        test('treats a 404 (already deleted) as success', async () => {
            mockFetchResponse(404);

            await expect(deleteMemoryFact('tok', 'mem-gone')).resolves.toBeUndefined();
        });

        test('throws on other HTTP errors', async () => {
            mockFetchResponse(403);

            await expect(deleteMemoryFact('tok', 'mem-1')).rejects.toThrow(
                'Failed to delete memory fact: 403'
            );
        });
    });
});
