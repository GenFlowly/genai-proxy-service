import {
    getLlmUsage,
    getEmbeddingUsage,
    getVectorDbUsage,
    getWebSearchUsage,
} from './getUsageService'
import { fetchWithRetry } from '../utils/apiUtils'
import { endpoints } from '../config/endpoints'

jest.mock('../utils/apiUtils')

const mockFetchWithRetry = fetchWithRetry as jest.Mock
const range = { from: '2026-09-25', to: '2026-10-25' }

describe('getUsageService', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    describe('getLlmUsage', () => {
        test('GETs with the bearer token and returns the parsed summary', async () => {
            const summary = { totalCostUsd: 1.5, byVendor: [], byModel: [] }
            mockFetchWithRetry.mockResolvedValue({ ok: true, status: 200, json: async () => summary })

            const result = await getLlmUsage('token-1', range)

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.usageLlm(range.from, range.to), {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
            })
            expect(result).toEqual(summary)
        })

        test('throws on a 404 — this endpoint is always expected to be live', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404 })
            await expect(getLlmUsage('token-1', range)).rejects.toThrow('unexpected 404')
        })

        test('throws on a non-404 failure', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' })
            await expect(getLlmUsage('token-1', range)).rejects.toThrow('500')
        })
    })

    describe('getEmbeddingUsage', () => {
        test('returns the parsed summary on success', async () => {
            const summary = { totalCostUsd: 0.2, byVendor: [], byModel: [] }
            mockFetchWithRetry.mockResolvedValue({ ok: true, status: 200, json: async () => summary })
            await expect(getEmbeddingUsage('token-1', range)).resolves.toEqual(summary)
        })

        test('returns null on a 404 instead of throwing', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404 })
            await expect(getEmbeddingUsage('token-1', range)).resolves.toBeNull()
        })
    })

    describe('getVectorDbUsage', () => {
        test('GETs the vector-db endpoint and returns raw op-count breakdown, no cost field', async () => {
            const summary = { breakdown: [{ opType: 'search', count: 12 }] }
            mockFetchWithRetry.mockResolvedValue({ ok: true, status: 200, json: async () => summary })

            const result = await getVectorDbUsage('token-1', range)

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.usageVectorDb(range.from, range.to), {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-1' },
            })
            expect(result).toEqual(summary)
        })

        test('returns null on a 404 (not tracked yet)', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404 })
            await expect(getVectorDbUsage('token-1', range)).resolves.toBeNull()
        })
    })

    describe('getWebSearchUsage', () => {
        test('returns the parsed estimate summary on success', async () => {
            const summary = { totalCostUsd: 0.05, isEstimate: true, breakdown: [{ key: 'basic', count: 5, costUsd: 0.05 }] }
            mockFetchWithRetry.mockResolvedValue({ ok: true, status: 200, json: async () => summary })
            await expect(getWebSearchUsage('token-1', range)).resolves.toEqual(summary)
        })

        test('returns null on a 404 instead of throwing', async () => {
            mockFetchWithRetry.mockResolvedValue({ ok: false, status: 404 })
            await expect(getWebSearchUsage('token-1', range)).resolves.toBeNull()
        })
    })
})
