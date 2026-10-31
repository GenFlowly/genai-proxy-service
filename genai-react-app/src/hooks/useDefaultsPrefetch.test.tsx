import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { useDefaultsPrefetch } from './useDefaultsPrefetch';
import { useAuth } from '../context/AuthContext';
import { fetchProviderCatalog } from '../services/providerCatalogService';
import { getRequestAgents } from '../services/requestAgentsService';
import { getCustomerAgents } from '../services/agentsService';
import { getEmbeddingModels } from '../services/embeddingKeysService';
import { customerAgentsCache, requestAgentsCache } from '../services/defaultsCacheService';
import { withQueryClient } from '../test/utils/queryWrapper';

jest.mock('../context/AuthContext');
jest.mock('../services/providerCatalogService', () => ({
    ...jest.requireActual('../services/providerCatalogService'),
    fetchProviderCatalog: jest.fn(),
}));
jest.mock('../services/requestAgentsService');
jest.mock('../services/agentsService');
jest.mock('../services/embeddingKeysService');

const mockUseAuth = useAuth as jest.Mock;
const mockFetchCatalog = fetchProviderCatalog as jest.Mock;
const mockGetRequestAgents = getRequestAgents as jest.Mock;
const mockGetCustomerAgents = getCustomerAgents as jest.Mock;
const mockGetEmbeddingModels = getEmbeddingModels as jest.Mock;

function Probe(): React.ReactElement {
    useDefaultsPrefetch();
    return <div />;
}

const authedState = (overrides: Record<string, unknown> = {}) => ({
    isAuthenticated: true,
    isSessionAuthenticated: true,
    isOnboarding: false,
    customerId: 'cust-1',
    cacheVersions: { agents: 1, requestAgents: 2, projects: 0 },
    getAccessTokenSilently: jest.fn().mockResolvedValue('tok'),
    ...overrides,
});

describe('useDefaultsPrefetch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
        mockFetchCatalog.mockResolvedValue({ providers: [] });
        mockGetRequestAgents.mockResolvedValue({ entries: [] });
        mockGetCustomerAgents.mockResolvedValue({ agents: [] });
    });

    test('warms providers, request-agents and agents once authenticated', async () => {
        mockUseAuth.mockReturnValue(authedState());

        render(withQueryClient(<Probe />));

        await waitFor(() => {
            expect(mockFetchCatalog).toHaveBeenCalledTimes(1);
            expect(mockGetRequestAgents).toHaveBeenCalledWith('tok');
            expect(mockGetCustomerAgents).toHaveBeenCalledWith('tok');
        });
    });

    test('never fetches the embedding-model catalog', async () => {
        mockUseAuth.mockReturnValue(authedState({ customerId: 'cust-embed' }));

        render(withQueryClient(<Probe />));

        await waitFor(() => expect(mockGetCustomerAgents).toHaveBeenCalled());
        expect(mockGetEmbeddingModels).not.toHaveBeenCalled();
    });

    test('does nothing while unauthenticated', () => {
        mockUseAuth.mockReturnValue(authedState({
            isAuthenticated: false,
            isSessionAuthenticated: false,
            customerId: null,
            cacheVersions: null,
        }));

        render(withQueryClient(<Probe />));

        expect(mockFetchCatalog).not.toHaveBeenCalled();
        expect(mockGetRequestAgents).not.toHaveBeenCalled();
        expect(mockGetCustomerAgents).not.toHaveBeenCalled();
    });

    test('version-gated resources are served from their envelopes without a network call', async () => {
        requestAgentsCache.save('cust-gated', { entries: [] } as any, 2);
        customerAgentsCache.save('cust-gated', { agents: [] } as any, 1);
        mockUseAuth.mockReturnValue(authedState({ customerId: 'cust-gated' }));

        render(withQueryClient(<Probe />));

        await waitFor(() => expect(mockFetchCatalog).toHaveBeenCalled());
        expect(mockGetRequestAgents).not.toHaveBeenCalled();
        expect(mockGetCustomerAgents).not.toHaveBeenCalled();
    });

    test('a version mismatch refetches and stores the new version', async () => {
        customerAgentsCache.save('cust-mismatch', { agents: [] } as any, 1);
        mockUseAuth.mockReturnValue(authedState({
            customerId: 'cust-mismatch',
            cacheVersions: { agents: 5, requestAgents: 2, projects: 0 },
        }));

        render(withQueryClient(<Probe />));

        await waitFor(() => expect(mockGetCustomerAgents).toHaveBeenCalledWith('tok'));
        await waitFor(() => expect(customerAgentsCache.getEnvelope('cust-mismatch')?.version).toBe(5));
    });

    test('waits out the /onboard sync before fetching version-gated resources', () => {
        mockUseAuth.mockReturnValue(authedState({ cacheVersions: null, isOnboarding: true }));

        render(withQueryClient(<Probe />));

        expect(mockGetRequestAgents).not.toHaveBeenCalled();
        expect(mockGetCustomerAgents).not.toHaveBeenCalled();
    });
});
