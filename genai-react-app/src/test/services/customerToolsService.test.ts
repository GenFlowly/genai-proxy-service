import {
    deleteCustomerTool,
    deleteToolCredentials,
    dryRunCustomerTool,
    DryRunResolvedRequest,
    errorFrom,
    getCustomerTool,
    getToolCredentialStatuses,
    listCustomerTools,
    MASKED_CREDENTIAL,
    maskOutboundRequest,
    parseJsonField,
    referencedArgumentKeys,
    referencesCredential,
    saveCustomerTool,
    storeToolCredentials,
    ToolRequestTemplate,
    UpsertCustomerToolRequest,
    urlOriginIsLiteral,
} from '../../services/customerToolsService';
import { endpoints } from '../../config/endpoints';
import * as apiUtils from '../../utils/apiUtils';

jest.mock('../../utils/apiUtils', () => ({
    fetchWithRetry: jest.fn(),
}));

const template = (overrides: Partial<ToolRequestTemplate> = {}): ToolRequestTemplate => ({
    method: 'GET',
    url: 'https://api.example.com/v1/items',
    headers: {},
    query: {},
    body: null,
    bodyType: 'json',
    ...overrides,
});

describe('customerToolsService helpers', () => {
    describe('referencedArgumentKeys', () => {
        test('collects keys from url, headers, query and body, deduplicated', () => {
            const keys = referencedArgumentKeys(template({
                url: 'https://api.example.com/{{args.city}}/weather',
                headers: { 'X-Unit': '{{args.unit}}' },
                query: { q: '{{ args.city }}' },
                body: { day: '{{args.day}}' },
            }));
            expect(keys).toEqual(['city', 'unit', 'day']);
        });

        test('a template with no placeholders and no body yields nothing', () => {
            expect(referencedArgumentKeys(template())).toEqual([]);
        });
    });

    describe('referencesCredential', () => {
        test('spots a credential placeholder, spaces allowed', () => {
            expect(referencesCredential('Bearer {{ credential.api_key }}')).toBe(true);
        });

        test('plain values and args placeholders do not count', () => {
            expect(referencesCredential('Bearer fixed-token')).toBe(false);
            expect(referencesCredential('{{args.city}}')).toBe(false);
        });
    });

    describe('urlOriginIsLiteral', () => {
        test('placeholder only in the path is legal', () => {
            expect(urlOriginIsLiteral('https://api.example.com/v1/{{args.id}}')).toBe(true);
        });

        test('placeholder in the host is not', () => {
            expect(urlOriginIsLiteral('https://{{args.host}}/v1')).toBe(false);
        });

        test('a url with no scheme is rejected outright', () => {
            expect(urlOriginIsLiteral('api.example.com/v1')).toBe(false);
        });

        test('a bare origin with no path is judged whole', () => {
            expect(urlOriginIsLiteral('https://api.example.com')).toBe(true);
        });
    });

    describe('maskOutboundRequest', () => {
        const outbound = (overrides: Partial<DryRunResolvedRequest> = {}): DryRunResolvedRequest => ({
            method: 'POST',
            url: 'https://api.example.com/v1/items',
            headers: { Authorization: 'Bearer real-secret', Accept: 'application/json' },
            query: { key: 'real-secret' },
            body: { note: 'hello' },
            ...overrides,
        });

        test('fields whose template pulled a credential are re-rendered masked', () => {
            const masked = maskOutboundRequest(outbound(), template({
                headers: { Authorization: 'Bearer {{credential.api_key}}', Accept: 'application/json' },
                query: { key: '{{credential.api_key}}' },
            }));
            expect(masked.headers.Authorization).toBe(`Bearer ${MASKED_CREDENTIAL}`);
            expect(masked.query.key).toBe(MASKED_CREDENTIAL);
            // Untouched fields come through exactly as resolved.
            expect(masked.headers.Accept).toBe('application/json');
            expect(masked.url).toBe('https://api.example.com/v1/items');
        });

        test('a credential anywhere in the body masks the whole payload', () => {
            const masked = maskOutboundRequest(outbound(), template({
                body: { token: '{{credential.api_key}}', note: 'hello' },
            }));
            expect(masked.body).toEqual({ token: MASKED_CREDENTIAL, note: 'hello' });
        });

        test('a body with no credential passes through as resolved', () => {
            const masked = maskOutboundRequest(outbound(), template({ body: { note: 'hi' } }));
            expect(masked.body).toEqual({ note: 'hello' });
        });

        test('a null resolved body stays null when nothing is masked', () => {
            const masked = maskOutboundRequest(outbound({ body: undefined }), template());
            expect(masked.body).toBeNull();
        });
    });

    describe('parseJsonField', () => {
        test('parses stored JSON', () => {
            expect(parseJsonField('{"mode":"text"}', { mode: 'json' })).toEqual({ mode: 'text' });
        });

        test('falls back on empty and on garbage', () => {
            expect(parseJsonField(null, { mode: 'json' })).toEqual({ mode: 'json' });
            expect(parseJsonField('not json', { mode: 'json' })).toEqual({ mode: 'json' });
        });
    });

    describe('errorFrom', () => {
        test('prefers the ErrorResponse message', async () => {
            const response = { status: 400, statusText: 'Bad Request', text: async () => '{"error":"name is taken"}' };
            await expect(errorFrom(response as unknown as Response, 'Save failed'))
                .resolves.toEqual(new Error('name is taken'));
        });

        test('uses the raw body when it is not an ErrorResponse', async () => {
            const response = { status: 502, statusText: 'Bad Gateway', text: async () => 'upstream exploded' };
            await expect(errorFrom(response as unknown as Response, 'Save failed'))
                .resolves.toEqual(new Error('upstream exploded'));
        });

        test('falls back to the status line when the body cannot be read', async () => {
            const response = { status: 500, statusText: 'Internal Server Error', text: async () => { throw new Error('gone'); } };
            await expect(errorFrom(response as unknown as Response, 'Save failed'))
                .resolves.toEqual(new Error('Save failed: 500 Internal Server Error'));
        });
    });
});

describe('customerToolsService API calls', () => {
    const token = 'mock-bearer-token';
    const fetchMock = apiUtils.fetchWithRetry as jest.Mock;

    const ok = (payload: unknown) => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => payload });
    const fail = (status: number, statusText: string) => fetchMock.mockResolvedValueOnce({
        ok: false, status, statusText, text: async () => '',
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('listCustomerTools GETs the collection with the bearer token', async () => {
        ok({ tools: [] });
        await expect(listCustomerTools(token)).resolves.toEqual({ tools: [] });
        expect(fetchMock).toHaveBeenCalledWith(endpoints.customerTools, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
    });

    test('listCustomerTools surfaces the server failure', async () => {
        fail(403, 'Forbidden');
        await expect(listCustomerTools(token)).rejects.toThrow('Get tools failed: 403 Forbidden');
    });

    test('getCustomerTool GETs the named tool', async () => {
        ok({ name: 'weather' });
        await expect(getCustomerTool(token, 'weather')).resolves.toEqual({ name: 'weather' });
        expect(fetchMock).toHaveBeenCalledWith(endpoints.customerTool('weather'), expect.objectContaining({ method: 'GET' }));
    });

    test('getCustomerTool surfaces the server failure', async () => {
        fail(404, 'Not Found');
        await expect(getCustomerTool(token, 'missing')).rejects.toThrow('Get tool failed: 404 Not Found');
    });

    test('saveCustomerTool POSTs the definition', async () => {
        const payload = { name: 'weather', status: 'draft' } as unknown as UpsertCustomerToolRequest;
        ok({ name: 'weather', version: 2 });
        await expect(saveCustomerTool(token, payload)).resolves.toEqual({ name: 'weather', version: 2 });
        expect(fetchMock).toHaveBeenCalledWith(endpoints.customerTools, expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(payload),
        }));
    });

    test('saveCustomerTool surfaces the validation message', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false, status: 400, statusText: 'Bad Request',
            text: async () => '{"error":"web_search is a reserved name"}',
        });
        await expect(saveCustomerTool(token, {} as UpsertCustomerToolRequest))
            .rejects.toThrow('web_search is a reserved name');
    });

    test('deleteCustomerTool DELETEs the named tool and resolves on ok', async () => {
        fetchMock.mockResolvedValueOnce({ ok: true });
        await expect(deleteCustomerTool(token, 'weather')).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith(endpoints.customerTool('weather'), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
    });

    test('deleteCustomerTool surfaces the server failure', async () => {
        fail(409, 'Conflict');
        await expect(deleteCustomerTool(token, 'weather')).rejects.toThrow('Delete tool failed: 409 Conflict');
    });

    test('dryRunCustomerTool POSTs with retries disabled — a dry run is a real call', async () => {
        ok({ ok: true });
        await expect(dryRunCustomerTool(token, 'weather', { args: { city: 'Lynnwood' } }))
            .resolves.toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledWith(endpoints.customerToolDryRun('weather'), expect.objectContaining({
            method: 'POST',
            retries: 0,
            body: JSON.stringify({ args: { city: 'Lynnwood' } }),
        }));
    });

    test('dryRunCustomerTool surfaces the server failure', async () => {
        fail(500, 'Internal Server Error');
        await expect(dryRunCustomerTool(token, 'weather', { args: {} }))
            .rejects.toThrow('Dry run failed: 500 Internal Server Error');
    });

    test('getToolCredentialStatuses returns the statuses with their settings', async () => {
        const statuses = {
            toolCredentialStatuses: [{
                toolType: 'WEB_SEARCH', authType: 'api_key', connected: true,
                settings: { max_searches_per_turn: '7' },
            }],
        };
        ok(statuses);
        await expect(getToolCredentialStatuses(token)).resolves.toEqual(statuses);
        expect(fetchMock).toHaveBeenCalledWith(endpoints.toolCredentials, expect.objectContaining({ method: 'GET' }));
    });

    test('getToolCredentialStatuses surfaces the server failure', async () => {
        fail(401, 'Unauthorized');
        await expect(getToolCredentialStatuses(token)).rejects.toThrow('Get tool credentials failed: 401 Unauthorized');
    });

    test('storeToolCredentials sends a settings-only payload untouched', async () => {
        const payload = { toolType: 'WEB_SEARCH', authType: 'api_key', settings: { max_searches_per_turn: '3' } };
        ok({ toolCredentialStatus: { toolType: 'WEB_SEARCH', authType: 'api_key', connected: false } });
        await storeToolCredentials(token, payload);
        expect(fetchMock).toHaveBeenCalledWith(endpoints.toolCredentials, expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(payload),
        }));
    });

    test('storeToolCredentials surfaces the validation message', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false, status: 400, statusText: 'Bad Request',
            text: async () => 'max_searches_per_turn must be an integer between 1 and 20',
        });
        await expect(storeToolCredentials(token, { toolType: 'WEB_SEARCH', authType: 'api_key' }))
            .rejects.toThrow('max_searches_per_turn must be an integer between 1 and 20');
    });

    test('deleteToolCredentials DELETEs the tool type and resolves on ok', async () => {
        fetchMock.mockResolvedValueOnce({ ok: true });
        await expect(deleteToolCredentials(token, 'WEB_SEARCH')).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith(endpoints.toolCredential('WEB_SEARCH'), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
    });

    test('deleteToolCredentials surfaces the server failure', async () => {
        fail(404, 'Not Found');
        await expect(deleteToolCredentials(token, 'WEB_SEARCH')).rejects.toThrow('Delete tool credentials failed: 404 Not Found');
    });
});
