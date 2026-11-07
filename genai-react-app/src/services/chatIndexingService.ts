import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { queryClient } from '../queryClient'

/**
 * Delete every chat the user's vector DB holds for search. Search results
 * cached before the delete are dropped with it. Returns how many vectors went.
 */
export async function deleteIndexedChats(token: string): Promise<number> {
    const response = await fetchWithRetry(endpoints.indexedChats, {
        method: HttpMethod.DELETE,
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
        throw new Error(`Failed to delete indexed chats: ${response.status} ${response.statusText}`)
    }
    queryClient.removeQueries({ queryKey: ['content-search'] })
    const data = await response.json()
    return typeof data?.deleted === 'number' ? data.deleted : 0
}
