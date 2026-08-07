import { storeCustomerSupabaseConfig } from '../../services/storeCustomerSupabaseConfigService';
import { endpoints } from '../../config/endpoints';

describe('storeCustomerSupabaseConfigService', () => {
    const mockToken = 'test-token';
    const mockRequest = {
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key'
    };
    const mockResponse = {
        configStatus: {
            vendor: 'SUPABASE',
            status: 'PRESENT',
            isConfigValid: true,
            updateSuccessful: true
        }
    };

    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.resetAllMocks();
    });

    test('successfully stores supabase config', async () => {
        const mockFetch = global.fetch as jest.Mock;
        mockFetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue(mockResponse),
        });

        const result = await storeCustomerSupabaseConfig(mockToken, mockRequest);

        expect(global.fetch).toHaveBeenCalledWith(
            endpoints.storeCustomerSupabaseConfig,
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
        const mockFetch = global.fetch as jest.Mock;
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: jest.fn().mockResolvedValue('Invalid configuration'),
        });

        await expect(storeCustomerSupabaseConfig(mockToken, mockRequest))
            .rejects.toThrow('Failed to store Supabase configuration: 400 Bad Request - Invalid configuration');
    });

    test('logs and rethrows error on network failure', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const networkError = new Error('Network Error');
        const mockFetch = global.fetch as jest.Mock;
        mockFetch.mockRejectedValue(networkError);

        await expect(storeCustomerSupabaseConfig(mockToken, mockRequest))
            .rejects.toThrow('Network Error');
        
        expect(consoleSpy).toHaveBeenCalledWith('storeCustomerSupabaseConfig error:', networkError);
        consoleSpy.mockRestore();
    });
});
