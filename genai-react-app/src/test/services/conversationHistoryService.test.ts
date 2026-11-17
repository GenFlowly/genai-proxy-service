import {
    deleteConversation,
    deleteProject,
    getCustomerConversations,
    getPinnedConversations,
    pinConversation,
    renameProject,
    unpinConversation,
} from '../../services/conversationHistoryService';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { fetchWithRetry } from '../../utils/apiUtils';
import { queryClient } from '../../queryClient';
import { MEMORIES_QUERY_KEY, PROJECTS_QUERY_KEY } from '../../hooks/queries/queryKeys';
import {
    clearHistoryCache,
    HistoryCacheState,
    loadHistoryCache,
    saveHistoryCache,
} from '../../components/widgets/ConversationHistoryWidget/historyCache';

jest.mock('../../utils/apiUtils', () => ({
    fetchWithRetry: jest.fn(),
}));

describe('conversationHistoryService', () => {
    const mockToken = 'mock-token';
    const mockConversationId = 'conv-123';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('deleteConversation', () => {
        it('should call fetchWithRetry with correct parameters', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true });

            await deleteConversation(mockToken, mockConversationId);

            expect(fetchWithRetry).toHaveBeenCalledWith(
                endpoints.deleteConversation(mockConversationId),
                {
                    method: HttpMethod.DELETE,
                    headers: {
                        Authorization: `Bearer ${mockToken}`,
                    },
                }
            );
        });

        it('should throw an error if the response is not ok', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                statusText: 'Internal Server Error',
            });

            await expect(deleteConversation(mockToken, mockConversationId)).rejects.toThrow(
                'Failed to delete conversation: Internal Server Error'
            );
        });
    });

    describe('pinConversation', () => {
        it('should call fetchWithRetry with correct parameters', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true });

            await pinConversation(mockToken, mockConversationId);

            expect(fetchWithRetry).toHaveBeenCalledWith(
                endpoints.pinConversation(mockConversationId),
                {
                    method: HttpMethod.POST,
                    headers: {
                        Authorization: `Bearer ${mockToken}`,
                    },
                }
            );
        });

        it('should throw an error if the response is not ok', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                statusText: 'Forbidden',
            });

            await expect(pinConversation(mockToken, mockConversationId)).rejects.toThrow(
                'Failed to pin conversation: Forbidden'
            );
        });
    });

    describe('unpinConversation', () => {
        it('should call fetchWithRetry with correct parameters', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true });

            await unpinConversation(mockToken, mockConversationId);

            expect(fetchWithRetry).toHaveBeenCalledWith(
                endpoints.unpinConversation(mockConversationId),
                {
                    method: HttpMethod.POST,
                    headers: {
                        Authorization: `Bearer ${mockToken}`,
                    },
                }
            );
        });

        it('should throw an error if the response is not ok', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                statusText: 'Internal Server Error',
            });

            await expect(unpinConversation(mockToken, mockConversationId)).rejects.toThrow(
                'Failed to unpin conversation: Internal Server Error'
            );
        });
    });

    describe('getPinnedConversations', () => {
        it('should call fetchWithRetry and return data', async () => {
            const mockData = { conversations: [{ conversationId: 'conv-1', pinnedAt: '2026-08-30T00:00:00Z' }] };
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValueOnce(mockData),
            });

            const result = await getPinnedConversations(mockToken);

            expect(fetchWithRetry).toHaveBeenCalledWith(
                endpoints.getPinnedConversations,
                {
                    method: HttpMethod.GET,
                    headers: {
                        Authorization: `Bearer ${mockToken}`,
                    },
                }
            );
            expect(result).toEqual(mockData);
        });

        it('should throw an error if response is not ok', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                statusText: 'Bad Request',
            });

            await expect(getPinnedConversations(mockToken)).rejects.toThrow(
                'Failed to fetch pinned conversations: Bad Request'
            );
        });
    });

    describe('getCustomerConversations', () => {
        it('should call fetchWithRetry and return data', async () => {
            const mockData = { items: [], nextToken: null };
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValueOnce(mockData),
            });

            const result = await getCustomerConversations(mockToken, 10, 'key1');

            expect(fetchWithRetry).toHaveBeenCalledWith(
                `${endpoints.getCustomerConversations}?pageSize=10&lastEvaluatedKey=key1`,
                {
                    method: HttpMethod.GET,
                    headers: {
                        Authorization: `Bearer ${mockToken}`,
                    },
                }
            );
            expect(result).toEqual(mockData);
        });

        it('should throw an error if response is not ok', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                statusText: 'Bad Request',
            });

            await expect(getCustomerConversations(mockToken)).rejects.toThrow(
                'Failed to fetch conversations: Bad Request'
            );
        });
    });
    describe('project mutations write through to the caches', () => {
        const startup = { projectId: 'p1', name: 'Startup', createdAt: 'c', updatedAt: 'u' }
        const bugs = { projectId: 'p2', name: 'Bugs', createdAt: 'c', updatedAt: 'u' }
        const inStartup = { conversationId: 'c1', title: 'Pitch', createdAt: null, updatedAt: null, projectId: 'p1', projectName: 'Startup' }
        const elsewhere = { conversationId: 'c2', title: 'Loan', createdAt: null, updatedAt: null }
        const seed: HistoryCacheState = {
            items: [inStartup, elsewhere],
            pinned: [{ ...inStartup, pinnedAt: 'x' }],
            lastKey: null,
            hasMore: false,
            projects: [startup, bugs],
            projectItems: { p1: [inStartup], p2: [] },
        }

        beforeEach(() => {
            clearHistoryCache()
            saveHistoryCache('cust-1', seed)
            queryClient.setQueryData([PROJECTS_QUERY_KEY, 'cust-1'], [startup, bugs])
        })

        afterEach(() => {
            queryClient.clear()
            clearHistoryCache()
        })

        it('renameProject posts the name and renames the project everywhere it is cached', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true })

            await renameProject(mockToken, 'p1', '  Launch  ')

            expect(fetchWithRetry).toHaveBeenCalledWith(endpoints.renameProject('p1'), {
                method: HttpMethod.POST,
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: '  Launch  ' }),
            })
            const cached = loadHistoryCache('cust-1')!
            expect(cached.projects.map(p => p.name)).toEqual(['Launch', 'Bugs'])
            expect(cached.items[0].projectName).toBe('Launch')
            expect(cached.items[1].projectName).toBeUndefined()
            expect(cached.pinned[0].projectName).toBe('Launch')
            expect(cached.projectItems.p1[0].projectName).toBe('Launch')
            expect(queryClient.getQueryData([PROJECTS_QUERY_KEY, 'cust-1'])).toEqual([
                { ...startup, name: 'Launch' },
                bugs,
            ])
        })

        it('a failed rename throws and leaves the caches alone', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: false, statusText: 'Bad Request' })

            await expect(renameProject(mockToken, 'p1', 'Launch')).rejects.toThrow('Failed to rename project: Bad Request')

            expect(loadHistoryCache('cust-1')).toEqual(seed)
            expect(queryClient.getQueryData([PROJECTS_QUERY_KEY, 'cust-1'])).toEqual([startup, bugs])
        })

        it('deleteProject deletes, returns its chats to the global lists and refetches memories', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true })
            const invalidate = jest.spyOn(queryClient, 'invalidateQueries')

            await deleteProject(mockToken, 'p1')

            expect(fetchWithRetry).toHaveBeenCalledWith(endpoints.deleteProject('p1'), {
                method: HttpMethod.DELETE,
                headers: { Authorization: `Bearer ${mockToken}` },
            })
            const cached = loadHistoryCache('cust-1')!
            expect(cached.projects).toEqual([bugs])
            expect(cached.projectItems).toEqual({ p2: [] })
            expect(cached.items[0]).toMatchObject({ conversationId: 'c1', projectId: null, projectName: null })
            expect(cached.pinned[0]).toMatchObject({ projectId: null })
            expect(queryClient.getQueryData([PROJECTS_QUERY_KEY, 'cust-1'])).toEqual([bugs])
            expect(invalidate).toHaveBeenCalledWith({ queryKey: [MEMORIES_QUERY_KEY] })
            invalidate.mockRestore()
        })

        it('a project that is already gone counts as deleted', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })

            await deleteProject(mockToken, 'p1')

            expect(loadHistoryCache('cust-1')!.projects).toEqual([bugs])
        })

        it('a failed delete throws and leaves the caches alone', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })

            await expect(deleteProject(mockToken, 'p1')).rejects.toThrow('Failed to delete project: Server Error')

            expect(loadHistoryCache('cust-1')).toEqual(seed)
            expect(queryClient.getQueryData([PROJECTS_QUERY_KEY, 'cust-1'])).toEqual([startup, bugs])
        })

        it('with nothing cached, a mutation still succeeds', async () => {
            clearHistoryCache()
            ;(fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true })

            await renameProject(mockToken, 'p1', 'Launch')

            expect(loadHistoryCache('cust-1')).toBeNull()
        })
    })
});
// Trigger test run for coverage
