import {
    customerAgentsCache,
    embeddingModelsCache,
    prefetchDefaultsPageData,
    requestAgentsCache,
} from './defaultsCacheService';
import { getRequestAgents } from './requestAgentsService';
import { getCustomerAgents } from './agentsService';
import { getEmbeddingModels } from './embeddingKeysService';
import { getProviderCatalog } from './providerCatalogService';

jest.mock('./requestAgentsService');
jest.mock('./agentsService');
jest.mock('./embeddingKeysService');
jest.mock('./providerCatalogService');

const mockGetRequestAgents = getRequestAgents as jest.Mock;
const mockGetCustomerAgents = getCustomerAgents as jest.Mock;
const mockGetEmbeddingModels = getEmbeddingModels as jest.Mock;
const mockGetProviderCatalog = getProviderCatalog as jest.Mock;

// The module keeps a memory cache across tests, so each test uses its own
// customerId — a mismatched id always reads as a miss.
describe('defaultsCacheService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
    });

    test('fetch stores the response and getCached serves it for the same customer only', async () => {
        const data = { entries: [{ requestType: 'CONVERSATION_TITLE' }] };
        mockGetRequestAgents.mockResolvedValue(data);

        await expect(requestAgentsCache.fetch('tok', 'CU_A')).resolves.toEqual(data);

        expect(requestAgentsCache.getCached('CU_A')).toEqual(data);
        expect(requestAgentsCache.getCached('CU_SOMEONE_ELSE')).toBeNull();
        expect(JSON.parse(localStorage.getItem('request_agents_cache')!)).toEqual({
            customerId: 'CU_A',
            data,
        });
    });

    test('getCached falls back to a previous session copy in localStorage', () => {
        localStorage.setItem(
            'customer_agents_cache',
            JSON.stringify({ customerId: 'CU_LS', data: { agents: [{ graphId: 'G1' }] } })
        );

        expect(customerAgentsCache.getCached('CU_LS')).toEqual({ agents: [{ graphId: 'G1' }] });
    });

    test('getCached survives a corrupt localStorage entry', () => {
        localStorage.setItem('customer_agents_cache', 'not json');
        expect(customerAgentsCache.getCached('CU_CORRUPT')).toBeNull();
    });

    test('concurrent fetches for the same customer share one request', async () => {
        let resolveProbe: (value: unknown) => void = () => undefined;
        mockGetEmbeddingModels.mockReturnValue(new Promise(resolve => { resolveProbe = resolve; }));

        const first = embeddingModelsCache.fetch('tok', 'CU_D');
        const second = embeddingModelsCache.fetch('tok', 'CU_D');
        expect(mockGetEmbeddingModels).toHaveBeenCalledTimes(1);

        resolveProbe({ vendorModels: [] });
        await expect(first).resolves.toEqual({ vendorModels: [] });
        await expect(second).resolves.toEqual({ vendorModels: [] });
    });

    test('a failed fetch leaves the cache untouched and a retry fetches again', async () => {
        mockGetEmbeddingModels.mockRejectedValueOnce(new Error('down'));
        await expect(embeddingModelsCache.fetch('tok', 'CU_F')).rejects.toThrow('down');
        expect(embeddingModelsCache.getCached('CU_F')).toBeNull();

        mockGetEmbeddingModels.mockResolvedValueOnce({ vendorModels: [{ vendor: 'VOYAGE', models: [] }] });
        await embeddingModelsCache.fetch('tok', 'CU_F');
        expect(embeddingModelsCache.getCached('CU_F')).toEqual({
            vendorModels: [{ vendor: 'VOYAGE', models: [] }],
        });
    });

    test('prefetchDefaultsPageData warms every cache and swallows individual failures', async () => {
        mockGetRequestAgents.mockRejectedValue(new Error('down'));
        mockGetCustomerAgents.mockResolvedValue({ agents: [] });
        mockGetProviderCatalog.mockResolvedValue({ providers: [] });

        await prefetchDefaultsPageData('tok', 'CU_P');

        expect(mockGetRequestAgents).toHaveBeenCalledWith('tok');
        expect(mockGetCustomerAgents).toHaveBeenCalledWith('tok');
        expect(mockGetProviderCatalog).toHaveBeenCalledWith('tok');
        expect(customerAgentsCache.getCached('CU_P')).toEqual({ agents: [] });
        expect(requestAgentsCache.getCached('CU_P')).toBeNull();
    });

    test('prefetchDefaultsPageData does not fetch the embedding-model catalog', async () => {
        mockGetRequestAgents.mockResolvedValue({ entries: [] });
        mockGetCustomerAgents.mockResolvedValue({ agents: [] });
        mockGetProviderCatalog.mockResolvedValue({ providers: [] });

        await prefetchDefaultsPageData('tok', 'CU_P');

        expect(mockGetEmbeddingModels).not.toHaveBeenCalled();
    });
});
