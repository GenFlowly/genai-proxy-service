export type SearchErrorCode = 'SEARCH_NOT_CONFIGURED' | 'SEARCH_UNAVAILABLE'
export type SearchSetupReason = 'VECTOR_DB_NOT_CONFIGURED' | 'EMBEDDING_KEY_MISSING'

/**
 * A search the API couldn't run. When notConfigured, retrying won't help
 * until the customer adds the setting named by reason.
 */
export class SearchError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: SearchErrorCode,
        readonly reason?: SearchSetupReason
    ) {
        super(message)
        this.name = 'SearchError'
    }

    get notConfigured(): boolean {
        return this.code === 'SEARCH_NOT_CONFIGURED'
    }
}

export async function searchErrorFrom(response: Response, label: string): Promise<SearchError> {
    let body: { code?: SearchErrorCode; reason?: SearchSetupReason } = {}
    try {
        body = (await response.json()) ?? {}
    } catch {
        // Not every failure carries a JSON body (gateways, older servers).
    }
    return new SearchError(`${label}: ${response.status} ${response.statusText}`, response.status, body.code, body.reason)
}

export function isSearchNotConfigured(error: unknown): error is SearchError {
    return error instanceof SearchError && error.notConfigured
}

/** The Settings page where the missing setting is added. */
export function searchSetupPath(reason?: SearchSetupReason): string {
    return reason === 'EMBEDDING_KEY_MISSING' ? '/settings/byok/embedding-keys' : '/settings/byok/vector-db'
}

/** Translation key for the "search isn't set up" message. */
export function searchSetupMessageKey(reason?: SearchSetupReason): string {
    return reason === 'EMBEDDING_KEY_MISSING'
        ? 'common.search.notSetUpEmbeddingKey'
        : 'common.search.notSetUpVectorDb'
}
