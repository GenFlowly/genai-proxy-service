import { getCustomerAgents, updateAgent } from '../../services/agentsService';
import { UpdateAgentRequest } from '../../models/agents.models';
import { endpoints } from '../../config/endpoints';
import * as apiUtils from '../../utils/apiUtils';

jest.mock('../../utils/apiUtils', () => ({
    fetchWithRetry: jest.fn(),
}));

describe('agentsService', () => {
    const mockToken = 'mock-bearer-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getCustomerAgents', () => {
        test('calls getCustomerAgents endpoint with GET and Authorization header', async () => {
            const mockResponse = { agents: [{ graphId: 'g1', name: 'Agent 1' }] };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await getCustomerAgents(mockToken);

            expect(apiUtils.fetchWithRetry).toHaveBeenCalledWith(endpoints.getCustomerAgents, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                    'Content-Type': 'application/json',
                },
            });
            expect(result).toEqual(mockResponse);
        });

        test('throws error message on HTTP failure', async () => {
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
            });

            await expect(getCustomerAgents(mockToken)).rejects.toThrow('Get Customer Agents failed: 403 Forbidden');
        });
    });

    describe('updateAgent', () => {
        test('calls updateAgent endpoint with PUT and JSON body', async () => {
            const updateReq: UpdateAgentRequest = { name: 'New Name', maxIterations: 15 };
            const mockResponse = { graphId: 'g1', name: 'New Name', maxIterations: 15 };

            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await updateAgent(mockToken, 'g1', updateReq);

            expect(apiUtils.fetchWithRetry).toHaveBeenCalledWith(`${endpoints.getCustomerAgents}/g1`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(updateReq),
            });
            expect(result).toEqual(mockResponse);
        });

        test('throws error message from response body on HTTP failure', async () => {
            const updateReq: UpdateAgentRequest = { name: 'Invalid Graph' };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                json: async () => ({ error: 'Graph validation failed: disconnected nodes' }),
            });

            await expect(updateAgent(mockToken, 'g1', updateReq)).rejects.toThrow('Graph validation failed: disconnected nodes');
        });

        test('throws fallback status message on HTTP failure when error property is missing', async () => {
            const updateReq: UpdateAgentRequest = { name: 'Bad Response' };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 502,
                statusText: 'Bad Gateway',
                json: async () => ({}),
            });

            await expect(updateAgent(mockToken, 'g1', updateReq)).rejects.toThrow('Update agent failed: 502 Bad Gateway');
        });
    });
});
