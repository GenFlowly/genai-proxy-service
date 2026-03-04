import { storeCustomerVectorDBConfig } from '../../../src/services/storeCustomerVectorDBConfigService';
import { endpoints } from '../../../src/config/endpoints';
import { HttpMethod } from '../../../src/constants/http';

// Mock matchers and fetch mapping
global.fetch = jest.fn();

describe('storeCustomerVectorDBConfig Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should successfully call the storeCustomerVectorDBConfig endpoint and return data', async () => {
        const mockToken = 'mock-jwt-token';
        const mockPayload = { vendor: 'Zilliz', endpoint: 'https://test-endpoint.zillizcloud.com', token: 'mock-token' };

        const mockResponse = {
            configStatus: {
                vendor: 'Zilliz',
                isConfigValid: true,
                status: 'PRESENT',
                updateSuccessful: true
            }
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockResponse),
        });

        const result = await storeCustomerVectorDBConfig(mockToken, mockPayload);

        expect(global.fetch).toHaveBeenCalledWith(endpoints.storeCustomerVectorDBConfig, {
            method: HttpMethod.POST,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${mockToken}`,
            },
            body: JSON.stringify(mockPayload),
        });
        expect(result).toEqual(mockResponse);
    });

    it('should throw an error if the request fails', async () => {
        const mockToken = 'mock-jwt-token';
        const mockPayload = { vendor: 'Zilliz', endpoint: 'https://fail.zillizcloud.com', token: 'bad-token' };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            statusText: 'Internal Server Error',
        });

        await expect(storeCustomerVectorDBConfig(mockToken, mockPayload)).rejects.toThrow(
            'Failed to save Vector DB config: Internal Server Error'
        );
    });
});
