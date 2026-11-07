import { deleteIndexedChats } from '../../services/chatIndexingService';
import { queryClient } from '../../queryClient';

describe('chatIndexingService', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    const mockFetchResponse = (status: number, body: any = {}) => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: status >= 200 && status < 300,
            status,
            statusText: `HTTP ${status}`,
            json: async () => body,
        });
    };

    test('deletes the indexed chats with bearer auth and returns how many went', async () => {
        mockFetchResponse(200, { status: 'success', deleted: 9 });

        await expect(deleteIndexedChats('tok-1')).resolves.toBe(9);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/v1/indexing/chats'),
            expect.objectContaining({
                method: 'DELETE',
                headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }),
            })
        );
    });

    test('drops cached search results, which may hold deleted chats', async () => {
        mockFetchResponse(200, { deleted: 1 });
        const removeQueries = jest.spyOn(queryClient, 'removeQueries');

        await deleteIndexedChats('tok-1');

        expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['content-search'] });
    });

    test('a body without a count reads as zero', async () => {
        mockFetchResponse(200, { status: 'success' });

        await expect(deleteIndexedChats('tok-1')).resolves.toBe(0);
    });

    test('a failed delete throws and leaves the cache alone', async () => {
        mockFetchResponse(400, { error: 'nope' });
        const removeQueries = jest.spyOn(queryClient, 'removeQueries');

        await expect(deleteIndexedChats('tok-1')).rejects.toThrow('Failed to delete indexed chats: 400');
        expect(removeQueries).not.toHaveBeenCalled();
    });
});
