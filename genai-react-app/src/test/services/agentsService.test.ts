import { createGraphAgent, forkAgent, getAgent, getCustomerAgents, updateAgent } from '../../services/agentsService';
import { CreateGraphAgentRequest, UpdateAgentRequest } from '../../models/agents.models';
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

    describe('getAgent', () => {
        test('calls the single-agent endpoint with GET and Authorization header', async () => {
            const mockResponse = { graphId: 'g1', name: 'Agent 1', isSystem: true };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await getAgent(mockToken, 'g1');

            expect(apiUtils.fetchWithRetry).toHaveBeenCalledWith(endpoints.getAgent('g1'), {
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
                status: 404,
                statusText: 'Not Found',
            });

            await expect(getAgent(mockToken, 'missing')).rejects.toThrow('Get Agent failed: 404 Not Found');
        });
    });

    describe('createGraphAgent', () => {
        const createReq: CreateGraphAgentRequest = {
            name: 'New Graph',
            maxIterations: 5,
            entryPoint: 'tmp-1',
            edges: '{}',
            layout: '{"tmp-1":{"x":0,"y":0}}',
            nodes: [{ tempId: 'tmp-1', nodeType: 'QUERY_ANALYZER', name: 'Analyzer', config: '{}' }],
        };

        test('calls the graph creation endpoint with POST and JSON body', async () => {
            const mockResponse = { graphId: 'g-new', name: 'New Graph' };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await createGraphAgent(mockToken, createReq);

            expect(apiUtils.fetchWithRetry).toHaveBeenCalledWith(endpoints.createAgentGraph, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(createReq),
            });
            expect(result).toEqual(mockResponse);
        });

        test('throws error message from response body on HTTP failure', async () => {
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                json: async () => ({ error: 'entryPoint tempId not in nodes' }),
            });

            await expect(createGraphAgent(mockToken, createReq)).rejects.toThrow('entryPoint tempId not in nodes');
        });

        test('throws fallback status message when error property is missing', async () => {
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => { throw new Error('not json') },
            });

            await expect(createGraphAgent(mockToken, createReq)).rejects.toThrow('Create graph agent failed: 500 Internal Server Error');
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

    describe('forkAgent', () => {
        test('POSTs to the fork endpoint and returns the fork', async () => {
            const mockFork = { graphId: 'g-fork', name: 'Agent-3-forked', isSystem: false, category: 'MEMORY' };
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => mockFork,
            });

            const result = await forkAgent(mockToken, 'g-sys');

            expect(apiUtils.fetchWithRetry).toHaveBeenCalledWith(endpoints.forkAgent('g-sys'), {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${mockToken}`,
                    'Content-Type': 'application/json',
                },
            });
            expect(result).toEqual(mockFork);
        });

        test('throws error message from response body on HTTP failure', async () => {
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: async () => ({ error: "Agent (graph) 'g-sys' not found." }),
            });

            await expect(forkAgent(mockToken, 'g-sys')).rejects.toThrow("Agent (graph) 'g-sys' not found.");
        });

        test('throws fallback status message when the error body is empty', async () => {
            (apiUtils.fetchWithRetry as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => ({}),
            });

            await expect(forkAgent(mockToken, 'g-sys')).rejects.toThrow('Fork agent failed: 500 Internal Server Error');
        });
    });
});
