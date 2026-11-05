import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'

export type SearchDataType = 'conversation' | 'notes'

export interface SearchResultItem {
    type: string
    key: string
    title?: string | null
    snippet: string
    score: number
    matchedChunks: number
    createdAt?: string | null
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
        throw new Error(`Search failed: ${response.status} ${response.statusText}`)
    }

    return ((await response.json()) as SearchResponse).results
}
