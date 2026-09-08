import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'

/**
 * True cancel for an in-flight streamed generation. Aborting the fetch alone
 * no longer stops the model — generation is decoupled from the HTTP stream so
 * it survives mobile backgrounding — so the Stop button also calls this.
 * The partial text streamed so far is persisted server-side.
 */
export async function cancelGeneration(token: string, responseMessageId: string): Promise<boolean> {
    const response = await fetch(endpoints.cancelGeneration(responseMessageId), {
        method: HttpMethod.POST,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })
    if (!response.ok) {
        throw new Error(`Failed to cancel generation: ${response.statusText}`)
    }
    const body = await response.json().catch(() => ({}))
    return body?.cancelled === true
}
