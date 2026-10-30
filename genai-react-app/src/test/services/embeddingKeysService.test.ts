import {
    deleteEmbeddingKey,
    getEmbeddingKeys,
    getEmbeddingModels,
    storeEmbeddingKey,
    EmbeddingVendor,
} from '../../services/embeddingKeysService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { endpoints } from '../../config/endpoints';

jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;

describe('embeddingKeysService', () => {
    const mockToken = 'test-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getEmbeddingKeys fetches the status list', async () => {
        const mockResponse = { statuses: [{ vendor: 'VOYAGE', isAPIKeyValid: true, status: 'API key is valid' }] };
        mockFetchWithRetry.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue(mockResponse) });

        const result = await getEmbeddingKeys(mockToken);

        expect(fetchWithRetry).toHaveBeenCalledWith(
            endpoints.getEmbeddingKeys,
            expect.objectContaining({
                method: 'GET',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mockToken}` },
            })
        );
        expect(result).toEqual(mockResponse);
    });

    test('getEmbeddingKeys throws when the response is not ok', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

        await expect(getEmbeddingKeys(mockToken)).rejects.toThrow('Get embedding keys failed: 500 Server Error');
    });

    test('getEmbeddingModels fetches the per-provider model list', async () => {
        const mockResponse = { vendorModels: [{ vendor: 'VOYAGE', models: ['voyage-4'] }] };
        mockFetchWithRetry.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue(mockResponse) });

        const result = await getEmbeddingModels(mockToken);

        expect(fetchWithRetry).toHaveBeenCalledWith(endpoints.getEmbeddingModels, expect.objectContaining({ method: 'GET' }));
        expect(result).toEqual(mockResponse);
    });

    test('getEmbeddingModels throws when the response is not ok', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' });

        await expect(getEmbeddingModels(mockToken)).rejects.toThrow('Get embedding models failed: 502 Bad Gateway');
    });

    test('storeEmbeddingKey posts the vendor and key', async () => {
        const mockResponse = { keyStatus: { vendor: 'HUGGINGFACE', isAPIKeyValid: true, status: 'API key is valid', updateSuccessful: true } };
        mockFetchWithRetry.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue(mockResponse) });

        const result = await storeEmbeddingKey(mockToken, EmbeddingVendor.HUGGINGFACE, 'hf_abc');

        expect(fetchWithRetry).toHaveBeenCalledWith(
            endpoints.storeEmbeddingKey,
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ vendor: 'HUGGINGFACE', apiKey: 'hf_abc' }),
            })
        );
        expect(result).toEqual(mockResponse);
    });

    test('storeEmbeddingKey throws when the response is not ok', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

        await expect(storeEmbeddingKey(mockToken, EmbeddingVendor.VOYAGE, 'pa-key'))
            .rejects.toThrow('Store embedding key failed: 400 Bad Request');
    });

    test('deleteEmbeddingKey issues a DELETE against the vendor path', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        await deleteEmbeddingKey(mockToken, EmbeddingVendor.HUGGINGFACE);

        expect(fetchWithRetry).toHaveBeenCalledWith(
            endpoints.deleteEmbeddingKey('HUGGINGFACE'),
            expect.objectContaining({
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mockToken}` },
            })
        );
    });

    test('deleteEmbeddingKey throws when the response is not ok', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

        await expect(deleteEmbeddingKey(mockToken, EmbeddingVendor.HUGGINGFACE))
            .rejects.toThrow('Delete embedding key failed: 400 Bad Request');
    });
});
