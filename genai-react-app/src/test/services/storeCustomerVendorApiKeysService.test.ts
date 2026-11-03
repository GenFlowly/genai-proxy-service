import { storeCustomerVendorApiKey } from '../../services/storeCustomerVendorApiKeysService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';
import { queryClient } from '../../queryClient';
import { TEXT_GEN_MODELS_QUERY_KEY } from '../../hooks/queries/queryKeys';

jest.mock('../../utils/apiUtils');

describe('storeCustomerVendorApiKeysService', () => {
    const mockToken = 'test-token';
    const mockRequest = { aiVendor: 'OpenAI', apiKey: 'test-key' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('successfully stores vendor api key', async () => {
        const mockResponse = { apiKeyStatus: { aiVendor: 'OpenAI', status: 'valid' } };
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

    describe('model lists', () => {
        const respondWith = (updateSuccessful: boolean) => {
            (fetchWithRetry as jest.Mock).mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ apiKeyStatus: { aiVendor: 'OpenAI', updateSuccessful } }),
            });
        };

        test('a saved key makes them stale', async () => {
            const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
            respondWith(true);

            await storeCustomerVendorApiKey(mockToken, mockRequest);

            expect(invalidate).toHaveBeenCalledWith({ queryKey: [TEXT_GEN_MODELS_QUERY_KEY] });
        });

        test('a rejected key leaves them alone', async () => {
            const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
            respondWith(false);

            await storeCustomerVendorApiKey(mockToken, mockRequest);

            expect(invalidate).not.toHaveBeenCalled();
        });
    });
});

describe('storeCustomerVendorConfig write-through', () => {
    const { storeCustomerVendorConfig } = require('../../services/storeCustomerVendorApiKeysService');
    const {
        setAiPreferencesCustomer,
        mergeAiPreferences,
        getAiPreferences,
    } = require('../../stores/aiPreferencesStore');

    test('mirrors the saved config into preferredModels on success', async () => {
        setAiPreferencesCustomer('CU_WT_CFG');
        mergeAiPreferences({ preferredModels: [{ aiVendor: 'CLAUDE', model: 'claude-x' }] });
        (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: true });

        await storeCustomerVendorConfig('test-token', {
            aiVendor: 'OPENAI',
            model: 'gpt-5',
            priority: 1,
            thinkingLevel: 'low',
        });

        expect(getAiPreferences()?.preferredModels).toEqual([
            { aiVendor: 'CLAUDE', model: 'claude-x' },
            { aiVendor: 'OPENAI', model: 'gpt-5', thinkingLevel: 'low' },
        ]);
    });

    test('does not mirror when the save fails', async () => {
        setAiPreferencesCustomer('CU_WT_CFG_FAIL');
        (fetchWithRetry as jest.Mock).mockResolvedValue({ ok: false, statusText: 'nope' });

        await expect(
            storeCustomerVendorConfig('test-token', { aiVendor: 'OPENAI', model: 'gpt-5', priority: 1 })
        ).rejects.toThrow();

        expect(getAiPreferences()?.preferredModels).toBeUndefined();
    });
});
