import { generateText } from '../../services/generateTextService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { mockGenerateTextRequest, mockGenerateTextResponse } from '../fixtures/generateText';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('generateTextService', () => {
    const mockToken = 'mock-auth-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('generateText calls fetchWithRetry with correct arguments and returns data', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockGenerateTextResponse)
        });

        // Act
        const result = await generateText(mockToken, mockGenerateTextRequest);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.generateText, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockGenerateTextRequest),
        });

        expect(result).toEqual(mockGenerateTextResponse);
    });

    test('generateText throws error when response is not ok', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error'
        });

        // Act & Assert
        await expect(generateText(mockToken, mockGenerateTextRequest))
            .rejects.toThrow('Text generation failed: 500 Internal Server Error');
    });
});
