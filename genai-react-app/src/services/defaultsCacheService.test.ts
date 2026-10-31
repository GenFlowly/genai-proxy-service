import {
    customerAgentsCache,
    embeddingModelsCache,
    requestAgentsCache,
} from './defaultsCacheService';

// The module keeps a memory cache across tests, so each test uses its own
// customerId — a mismatched id always reads as a miss.
describe('defaultsCacheService (SeededCache)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    test('save stores a versioned envelope under a per-customer key and getEnvelope serves it for the same customer only', () => {
        const data = { entries: [{ requestType: 'CONVERSATION_TITLE' }] } as any;
        requestAgentsCache.save('CU_A', data, 7);

        expect(requestAgentsCache.getEnvelope('CU_A')).toEqual({
            customerId: 'CU_A',
            version: 7,
            data,
        });
        expect(requestAgentsCache.getEnvelope('CU_SOMEONE_ELSE')).toBeNull();
        expect(JSON.parse(localStorage.getItem('CU_A_request_agents_cache')!)).toEqual({
            customerId: 'CU_A',
            version: 7,
            data,
        });
    });

    test('getEnvelope falls back to a previous session copy in localStorage', () => {
        localStorage.setItem(
            'CU_LS_customer_agents_cache',
            JSON.stringify({ customerId: 'CU_LS', version: 3, data: { agents: [{ graphId: 'G1' }] } })
        );

        expect(customerAgentsCache.getEnvelope('CU_LS')).toEqual({
            customerId: 'CU_LS',
            version: 3,
            data: { agents: [{ graphId: 'G1' }] },
        });
    });

    test('pre-versioning envelopes normalize to version null (never satisfy a version match)', () => {
        localStorage.setItem(
            'CU_OLD_customer_agents_cache',
            JSON.stringify({ customerId: 'CU_OLD', data: { agents: [] } })
        );

        expect(customerAgentsCache.getEnvelope('CU_OLD')?.version).toBeNull();
    });

    test('getEnvelope survives a corrupt localStorage entry', () => {
        localStorage.setItem('CU_CORRUPT_customer_agents_cache', 'not json');
        expect(customerAgentsCache.getEnvelope('CU_CORRUPT')).toBeNull();
    });

    test('an envelope stored under another customer id never leaks across customers', () => {
        localStorage.setItem(
            'CU_X_embedding_models_cache',
            JSON.stringify({ customerId: 'CU_OTHER', version: 1, data: { vendorModels: [] } })
        );

        expect(embeddingModelsCache.getEnvelope('CU_X')).toBeNull();
    });

    test('save with a null version round-trips (version gating off)', () => {
        embeddingModelsCache.save('CU_NULLV', { vendorModels: [] } as any, null);
        expect(embeddingModelsCache.getEnvelope('CU_NULLV')).toEqual({
            customerId: 'CU_NULLV',
            version: null,
            data: { vendorModels: [] },
        });
    });
});
