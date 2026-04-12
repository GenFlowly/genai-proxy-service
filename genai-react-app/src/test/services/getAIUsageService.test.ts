import { getAIUsageActivity } from '../../services/getAIUsageService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';

jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('getAIUsageActivity', () => {
    const mockToken = 'mock-auth-token';
    const mockConversationId = 'conv-123';
    const mockMessageId = 'msg-456';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should fetch AI usage metrics successfully', async () => {
        const mockMetrics = {
            inputTokens: 100,
            outputTokens: 200,
            totalTokens: 300,
            tokensReadFromCache: 50
        };

        mockFetchWithRetry.mockResolvedValueOnce({
            ok: true,
            json: async () => mockMetrics
        });

        const result = await getAIUsageActivity(mockToken, mockConversationId, mockMessageId);

        expect(result).toEqual(mockMetrics);
        
        // Check URL construction
        const expectedUrlObj = new URL(endpoints.getAIUsage);
        expectedUrlObj.searchParams.append("conversationId", mockConversationId);
        expectedUrlObj.searchParams.append("messageId", mockMessageId);
        
        expect(mockFetchWithRetry).toHaveBeenCalledWith(expectedUrlObj.toString(), {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${mockToken}`
            }
        });
    });

    test('should return null and warn on non-ok response', async () => {
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        mockFetchWithRetry.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        });

        const result = await getAIUsageActivity(mockToken, mockConversationId, mockMessageId);

        expect(result).toBeNull();
        expect(consoleWarnSpy).toHaveBeenCalledWith('Failed to fetch AI usage: 404 Not Found');

        consoleWarnSpy.mockRestore();
    });

    test('should return null and log error on exception', async () => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const mockError = new Error('Network Error');

        mockFetchWithRetry.mockRejectedValueOnce(mockError);

        const result = await getAIUsageActivity(mockToken, mockConversationId, mockMessageId);

        expect(result).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error fetching AI Usage:', mockError);

        consoleErrorSpy.mockRestore();
    });
});
