import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { HttpMethod } from '../../constants/http';
import { mockStoreApiKeyRequest, mockStoreApiKeyResponse } from '../fixtures/apiKey';

// Mock dependencies
jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('storeCustomerVendorApiKeysService', () => {
    const mockToken = 'mock-auth-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('storeCustomerVendorApiKey calls POST with correct data', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockStoreApiKeyResponse)
        });

        // Act
        const result = await storeCustomerVendorApiKey(mockToken, mockStoreApiKeyRequest);

        // Assert
        expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.storeCustomerVendorApiKey, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockStoreApiKeyRequest),
        });

        expect(result).toEqual(mockStoreApiKeyResponse);
    });

    test('storeCustomerVendorApiKey throws error on failure', async () => {
        // Arrange
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            statusText: 'Internal Server Error'
        });

        // Act & Assert
        await expect(storeCustomerVendorApiKey(mockToken, mockStoreApiKeyRequest))
            .rejects.toThrow('Failed to save key for OPENAI: Internal Server Error');
    });
});
