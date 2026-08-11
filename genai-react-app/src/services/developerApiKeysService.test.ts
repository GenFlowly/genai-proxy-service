import {
    createDeveloperApiKey,
    listDeveloperApiKeys,
    revokeDeveloperApiKey,
} from './developerApiKeysService'
import { fetchWithRetry } from '../utils/apiUtils'
import { endpoints } from '../config/endpoints'

jest.mock('../utils/apiUtils')

const mockFetchWithRetry = fetchWithRetry as jest.Mock

describe('developerApiKeysService', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    describe('createDeveloperApiKey', () => {
        test('posts the name and returns the created key', async () => {
            const created = {
                keyId: 'key-1',
                name: 'CI server',
                apiKey: 'gfy_secret',
                prefix: 'gfy_secret'.slice(0, 12),
                createdAt: '2026-01-01T00:00:00Z',
            }
            mockFetchWithRetry.mockResolvedValue({
                ok: true,
                json: async () => created,
            })

            const result = await createDeveloperApiKey('token-1', { name: 'CI server' })

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.developerApiKeys, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token-1',
                },
                body: JSON.stringify({ name: 'CI server' }),
            })
            expect(result).toEqual(created)
        })

        test('throws on non-ok response', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, statusText: 'Bad Request' })

            await expect(createDeveloperApiKey('token-1', { name: 'x' }))
                .rejects.toThrow('Failed to create API key: Bad Request')
        })
    })

    describe('listDeveloperApiKeys', () => {
        test('fetches and returns the key list', async () => {
            const list = { keys: [{ keyId: 'key-1', name: 'a', prefix: 'gfy_a' }] }
            mockFetchWithRetry.mockResolvedValue({
                ok: true,
                json: async () => list,
            })

            const result = await listDeveloperApiKeys('token-2')

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.developerApiKeys, {
                method: 'GET',
                headers: { Authorization: 'Bearer token-2' },
            })
            expect(result).toEqual(list)
        })

        test('throws on non-ok response', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, statusText: 'Forbidden' })

            await expect(listDeveloperApiKeys('token-2'))
                .rejects.toThrow('Failed to load API keys: Forbidden')
        })
    })

    describe('revokeDeveloperApiKey', () => {
        test('deletes the given key', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: true })

            await revokeDeveloperApiKey('token-3', 'key-9')

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.developerApiKey('key-9'), {
                method: 'DELETE',
                headers: { Authorization: 'Bearer token-3' },
            })
        })

        test('throws on non-ok response', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, statusText: 'Not Found' })

            await expect(revokeDeveloperApiKey('token-3', 'key-9'))
                .rejects.toThrow('Failed to revoke API key: Not Found')
        })
    })
})
