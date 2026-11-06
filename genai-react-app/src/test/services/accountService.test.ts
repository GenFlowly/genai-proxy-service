import { deleteAccount, deleteAllCredentials } from '../../services/accountService';
import { queryClient } from '../../queryClient';
import { EMBEDDING_MODELS_QUERY_KEY, TEXT_GEN_MODELS_QUERY_KEY } from '../../hooks/queries/queryKeys';

describe('accountService', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        global.fetch = jest.fn();
        queryClient.clear();
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

    describe('deleteAccount', () => {
        test('DELETEs the account with the typed confirmation and bearer auth', async () => {
            mockFetchResponse(202, { status: 'deletion_started' });

            await deleteAccount('tok-1');

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/v1/account'),
                expect.objectContaining({
                    method: 'DELETE',
                    headers: expect.objectContaining({ Authorization: 'Bearer tok-1' }),
                    body: JSON.stringify({ confirmation: 'DELETE' }),
                })
            );
        });

        test("throws with the server's message", async () => {
            mockFetchResponse(403, { error: "Admin-panel accounts can't be deleted here" });

            await expect(deleteAccount('tok')).rejects.toThrow("Admin-panel accounts can't be deleted here");
        });

        test('throws with the status when there is no message', async () => {
            (global.fetch as jest.Mock).mockResolvedValue({
                ok: false, status: 400, statusText: 'Bad Request', json: async () => { throw new Error('no body'); },
            });

            await expect(deleteAccount('tok')).rejects.toThrow('Failed to delete the account: 400 Bad Request');
        });
    });

    describe('deleteAllCredentials', () => {
        test('returns how many were removed and drops the model lists derived from the keys', async () => {
            queryClient.setQueryData([EMBEDDING_MODELS_QUERY_KEY, 'c1'], ['voyage-4-large']);
            queryClient.setQueryData([TEXT_GEN_MODELS_QUERY_KEY, 'c1', ['OPENAI']], ['gpt-5']);
            queryClient.setQueryData(['profile', 'c1'], { username: 'kept' });
            mockFetchResponse(200, { deleted: 4 });

            await expect(deleteAllCredentials('tok-2')).resolves.toBe(4);

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/api/v1/credentials'),
                expect.objectContaining({
                    method: 'DELETE',
                    headers: expect.objectContaining({ Authorization: 'Bearer tok-2' }),
                })
            );
            expect(queryClient.getQueryData([EMBEDDING_MODELS_QUERY_KEY, 'c1'])).toBeUndefined();
            expect(queryClient.getQueryData([TEXT_GEN_MODELS_QUERY_KEY, 'c1', ['OPENAI']])).toBeUndefined();
            expect(queryClient.getQueryData(['profile', 'c1'])).toEqual({ username: 'kept' });
        });

        test('a response without a count reads as none removed', async () => {
            mockFetchResponse(200, {});

            await expect(deleteAllCredentials('tok')).resolves.toBe(0);
        });

        test('a failure throws and leaves the cache alone', async () => {
            queryClient.setQueryData([EMBEDDING_MODELS_QUERY_KEY, 'c1'], ['voyage-4-large']);
            mockFetchResponse(403, { error: 'Failed to delete keys' });

            await expect(deleteAllCredentials('tok')).rejects.toThrow('Failed to delete keys');
            expect(queryClient.getQueryData([EMBEDDING_MODELS_QUERY_KEY, 'c1'])).toEqual(['voyage-4-large']);
        });
    });
});
