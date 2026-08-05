import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';

jest.mock('../../utils/apiUtils');

describe('storeCustomerVendorApiKeysService', () => {
    const mockToken = 'test-token';
    const mockRequest = { aiVendor: 'OpenAI', apiKey: 'test-key' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('successfully stores vendor api key', async () => {
        const mockResponse = { aiVendorAPIKeyStatus: { aiVendor: 'OpenAI', status: 'valid' } };
        const mockFetchWithRetry = fetchWithRetry as jest.Mock;
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockResponse),
        });

        const result = await storeCustomerVendorApiKey(mockToken, mockRequest);

        expect(fetchWithRetry).toHaveBeenCalledWith(
            endpoints.storeCustomerVendorApiKey,
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${mockToken}`
                },
                body: JSON.stringify(mockRequest)
            })
        );
        expect(result).toEqual(mockResponse);
    });

    test('throws error when response is not ok', async () => {
        const mockFetchWithRetry = fetchWithRetry as jest.Mock;
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            statusText: 'Bad Request'
        });

        await expect(storeCustomerVendorApiKey(mockToken, mockRequest))
            .rejects.toThrow('Failed to save key for OpenAI: Bad Request');
    });
});
