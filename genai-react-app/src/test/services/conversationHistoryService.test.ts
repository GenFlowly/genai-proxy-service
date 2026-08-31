import {
    archiveConversation,
    getCustomerConversations,
    getPinnedConversations,
    pinConversation,
    unarchiveConversation,
    unpinConversation,
} from '../../services/conversationHistoryService';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { fetchWithRetry } from '../../utils/apiUtils';

jest.mock('../../utils/apiUtils', () => ({
    fetchWithRetry: jest.fn(),
}));

describe('conversationHistoryService', () => {
    const mockToken = 'mock-token';
    const mockConversationId = 'conv-123';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('archiveConversation', () => {
        it('should call fetchWithRetry with correct parameters', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true });

            await archiveConversation(mockToken, mockConversationId);

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

            await expect(archiveConversation(mockToken, mockConversationId)).rejects.toThrow(
                'Failed to archive conversation: Internal Server Error'
            );
        });
    });

    describe('unarchiveConversation', () => {
        it('should call fetchWithRetry with correct parameters', async () => {
            (fetchWithRetry as jest.Mock).mockResolvedValueOnce({ ok: true });

            await unarchiveConversation(mockToken, mockConversationId);

            expect(fetchWithRetry).toHaveBeenCalledWith(
                endpoints.unarchiveConversation(mockConversationId),
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
                statusText: 'Not Found',
            });

            await expect(unarchiveConversation(mockToken, mockConversationId)).rejects.toThrow(
                'Failed to unarchive conversation: Not Found'
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
});
// Trigger test run for coverage
