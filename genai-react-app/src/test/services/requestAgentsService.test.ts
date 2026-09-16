import {
    deleteRequestAgentMapping,
    getRequestAgents,
    putRequestAgentMapping,
} from '../../services/requestAgentsService';
import { fetchWithRetry } from '../../utils/apiUtils';
import { config } from '../../config/env';

jest.mock('../../utils/apiUtils');

const mockFetchWithRetry = fetchWithRetry as jest.Mock;
const BASE = `${config.backend.baseUrl}/api/v1`;

describe('requestAgentsService', () => {
    const token = 'test-token';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('getRequestAgents returns the parsed action list', async () => {
        const payload = {
            entries: [
                {
                    requestType: 'NOTE_TITLE',
                    displayName: 'Note Title Generation',
                    templateVariables: ['{{noteContent}}'],
                    entry: null,
                    platformAgentName: 'NoteTitleDefaultAgent',
                },
            ],
        };
        mockFetchWithRetry.mockResolvedValue({ ok: true, json: async () => payload });

        const result = await getRequestAgents(token);

        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            `${BASE}/request-agents`,
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
            })
        );
        expect(result).toEqual(payload);
    });

    test('getRequestAgents throws on a failed response', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        await expect(getRequestAgents(token)).rejects.toThrow('Get request agents failed: 500');
    });

    test('putRequestAgentMapping PUTs the graphId to the action endpoint', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true });

        await putRequestAgentMapping(token, 'MEMORY_EXTRACTION', 'GRP123');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            `${BASE}/request-agents/MEMORY_EXTRACTION`,
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ graphId: 'GRP123' }),
            })
        );
    });

    test('putRequestAgentMapping surfaces the backend error detail', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: 'Invalid mapping: graph not found' }),
        });
        await expect(putRequestAgentMapping(token, 'NOTE_TITLE', 'GRPX')).rejects.toThrow(
            'Invalid mapping: graph not found'
        );
    });

    test('putRequestAgentMapping falls back to a status message without a JSON body', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Server Error',
            json: async () => {
                throw new Error('not json');
            },
        });
        await expect(putRequestAgentMapping(token, 'NOTE_TITLE', 'GRPX')).rejects.toThrow(
            'Save mapping failed: 500'
        );
    });

    test('deleteRequestAgentMapping DELETEs the action endpoint', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: true, status: 204 });

        await deleteRequestAgentMapping(token, 'CONVERSATION_TITLE');

        expect(mockFetchWithRetry).toHaveBeenCalledWith(
            `${BASE}/request-agents/CONVERSATION_TITLE`,
            expect.objectContaining({ method: 'DELETE' })
        );
    });

    test('deleteRequestAgentMapping tolerates 404 (nothing to remove)', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
        await expect(deleteRequestAgentMapping(token, 'NOTE_TITLE')).resolves.toBeUndefined();
    });

    test('deleteRequestAgentMapping throws on other failures', async () => {
        mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
        await expect(deleteRequestAgentMapping(token, 'NOTE_TITLE')).rejects.toThrow(
            'Remove mapping failed: 500'
        );
    });
});
