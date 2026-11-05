import {
    SearchError,
    isSearchNotConfigured,
    searchErrorFrom,
    searchSetupMessageKey,
    searchSetupPath,
} from '../../services/searchError'

const response = (status: number, body: unknown) => ({
    status,
    statusText: 'Status',
    json: async () => {
        if (body instanceof Error) throw body
        return body
    },
}) as unknown as Response

describe('searchErrorFrom', () => {
    test('reads the code and the missing setting', async () => {
        const error = await searchErrorFrom(
            response(409, { error: 'No vector DB', code: 'SEARCH_NOT_CONFIGURED', reason: 'VECTOR_DB_NOT_CONFIGURED' }),
            'Search failed'
        )
        expect(error).toBeInstanceOf(SearchError)
        expect(error.message).toBe('Search failed: 409 Status')
        expect(error.status).toBe(409)
        expect(error.reason).toBe('VECTOR_DB_NOT_CONFIGURED')
        expect(isSearchNotConfigured(error)).toBe(true)
    })

    test('a failure without a JSON body is a plain search failure', async () => {
        const error = await searchErrorFrom(response(502, new SyntaxError('not json')), 'Search failed')
        expect(error.status).toBe(502)
        expect(error.code).toBeUndefined()
        expect(isSearchNotConfigured(error)).toBe(false)
    })

    test('an unavailable search is not a setup problem', async () => {
        const error = await searchErrorFrom(response(502, { code: 'SEARCH_UNAVAILABLE' }), 'Search failed')
        expect(isSearchNotConfigured(error)).toBe(false)
    })
})

describe('search setup', () => {
    test('points at the Settings page for the missing setting', () => {
        expect(searchSetupPath('EMBEDDING_KEY_MISSING')).toBe('/settings/ai/embedding-keys')
        expect(searchSetupPath('VECTOR_DB_NOT_CONFIGURED')).toBe('/settings/ai/vector-db')
        expect(searchSetupPath(undefined)).toBe('/settings/ai/vector-db')
    })

    test('picks the message for the missing setting', () => {
        expect(searchSetupMessageKey('EMBEDDING_KEY_MISSING')).toBe('common.search.notSetUpEmbeddingKey')
        expect(searchSetupMessageKey('VECTOR_DB_NOT_CONFIGURED')).toBe('common.search.notSetUpVectorDb')
    })

    test('other errors are not setup problems', () => {
        expect(isSearchNotConfigured(new Error('boom'))).toBe(false)
        expect(isSearchNotConfigured(null)).toBe(false)
    })
})
