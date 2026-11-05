import { searchContent } from '../../services/searchService'
import { fetchWithRetry } from '../../utils/apiUtils'

jest.mock('../../utils/apiUtils')

const mockFetch = fetchWithRetry as jest.Mock

describe('searchContent', () => {
    test('encodes the query and limits the types', async () => {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [{ key: 'a' }] }) })

        const results = await searchContent('token', 'a&b', ['notes'])

        expect(results).toEqual([{ key: 'a' }])
        const [url, options] = mockFetch.mock.calls[0]
        expect(url).toContain('/search?q=a%26b&types=notes')
        expect(options.headers.Authorization).toBe('Bearer token')
    })

    test('throws on a failed response', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' })
        await expect(searchContent('token', 'a', ['notes'])).rejects.toThrow('Search failed: 500')
    })
})
