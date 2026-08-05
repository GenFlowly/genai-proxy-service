import { storeCustomerVectorDBConfig } from '../../services/storeCustomerVectorDBConfigService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';

jest.mock('../../utils/apiUtils');

describe('storeCustomerVectorDBConfigService', () => {
    const mockToken = 'test-token';
    const mockRequest = { vendor: 'ZILLIZ', zillizEndpoint: 'url', zillizToken: 'token' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('successfully stores vector db config', async () => {
        const mockResponse = { configStatus: { vendor: 'Zilliz', status: 'PRESENT' } };
        const mockFetchWithRetry = fetchWithRetry as jest.Mock;
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockResponse),
        });

        const result = await storeCustomerVectorDBConfig(mockToken, mockRequest);

        expect(fetchWithRetry).toHaveBeenCalledWith(
            endpoints.storeCustomerVectorDBConfig,
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

        await expect(storeCustomerVectorDBConfig(mockToken, mockRequest))
            .rejects.toThrow('Failed to save Vector DB config: Bad Request');
    });
});
