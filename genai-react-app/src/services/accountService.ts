import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { queryClient } from '../queryClient'
import { EMBEDDING_MODELS_QUERY_KEY, TEXT_GEN_MODELS_QUERY_KEY } from '../hooks/queries/queryKeys'

/** The text the backend requires to confirm an account deletion. */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE'

async function errorMessage(response: Response, fallback: string): Promise<string> {
    try {
        const body = await response.json()
        if (typeof body?.error === 'string' && body.error) return body.error
    } catch {
        // No JSON body; use the fallback
    }
    return `${fallback}: ${response.status} ${response.statusText}`
}

/**
 * Starts deleting the account. The backend cuts the login off before it
 * answers, so the caller should sign out right after.
 */
export async function deleteAccount(token: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.deleteAccount, {
        method: HttpMethod.DELETE,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirmation: DELETE_ACCOUNT_CONFIRMATION }),
    })
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to delete the account'))
    }
}

/**
 * Removes every key and credential the customer stored. Returns how many
 * were removed. The model lists derived from those keys are dropped from the
 * cache together with the backend change.
 */
export async function deleteAllCredentials(token: string): Promise<number> {
    const response = await fetchWithRetry(endpoints.deleteAllCredentials, {
        method: HttpMethod.DELETE,
        headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to delete keys'))
    }
    const body = await response.json()
    queryClient.removeQueries({ queryKey: [EMBEDDING_MODELS_QUERY_KEY] })
    queryClient.removeQueries({ queryKey: [TEXT_GEN_MODELS_QUERY_KEY] })
    return typeof body?.deleted === 'number' ? body.deleted : 0
}
