import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'

/**
 * True cancel for an in-flight streamed generation. Aborting the fetch alone
 * no longer stops the model — generation is decoupled from the HTTP stream so
 * it survives mobile backgrounding — so the Stop button also calls this.
 * The partial text streamed so far is persisted server-side.
 *
 * [generationId] is the client-generated id sent with the generate request
 * (works at any moment, even before response headers arrive) or the
 * server-side responseMessageId. Retried on transient failures: an
 * unacknowledged cancel means the model keeps generating and billing.
 */
export async function cancelGeneration(token: string, generationId: string): Promise<boolean> {
    const response = await fetchWithRetry(endpoints.cancelGeneration(generationId), {
        method: HttpMethod.POST,
        headers: {
            Authorization: `Bearer ${token}`,
        },
        retries: 2,
        backoff: 500,
    })
    if (!response.ok) {
        throw new Error(`Failed to cancel generation: ${response.statusText}`)
    }
    const body = await response.json().catch(() => ({}))
    return body?.cancelled === true
}
