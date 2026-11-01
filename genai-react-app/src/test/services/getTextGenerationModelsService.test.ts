import { getTextGenerationModels } from '../../services/getTextGenerationModelsService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { mockModelsResponse } from '../fixtures/aiConfig';
import { AIVendor } from '../../constants/vendors';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('getTextGenerationModelsService', () => {
    const mockToken = 'mock-auth-token';
    const mockCustomerId = 'cust-123';
    const mockRequest = { aiVendor: [AIVendor.OPENAI, AIVendor.CLAUDE] };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getTextGenerationModels calls fetchWithRetry and returns data', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockModelsResponse)
        });

        // Act
        const result = await getTextGenerationModels(mockToken, mockCustomerId, mockRequest);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            `${endpoints.getTextGenerationModels}?vendors=${encodeURIComponent(mockRequest.aiVendor.join(','))}`,
            {
                method: HttpMethod.GET,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${mockToken}`,
                },
            }
        );

        expect(result).toEqual(mockModelsResponse);
        expect(result.aiVendorModelList).toHaveLength(3);
    });

    test('getTextGenerationModels throws error on non-ok response', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable'
        });

        // Act & Assert
        await expect(getTextGenerationModels(mockToken, mockCustomerId, mockRequest))
            .rejects.toThrow('Failed to fetch models: 503 Service Unavailable');
    });

});
