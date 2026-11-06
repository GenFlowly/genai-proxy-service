import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { searchErrorFrom } from './searchError'

export type SearchDataType = 'conversation' | 'memory'

export interface SearchResultItem {
    type: string
    key: string
    title?: string | null
    snippet: string
    // Similarity for a vector-DB hit; absent for a keyword match.
    score?: number | null
    matchedChunks: number
    createdAt?: string | null
    // 'keyword': a record not yet in the vector DB that contains every query word.
    match?: 'semantic' | 'keyword'
}

interface SearchResponse {
    results: SearchResultItem[]
}

export async function searchContent(
    token: string,
    query: string,
    types: SearchDataType[]
): Promise<SearchResultItem[]> {
    const url = `${endpoints.search}?q=${encodeURIComponent(query)}&types=${types.join(',')}`
    const response = await fetchWithRetry(url, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw await searchErrorFrom(response, 'Search failed')
    }

    return ((await response.json()) as SearchResponse).results
}
