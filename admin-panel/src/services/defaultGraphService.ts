import { endpoints } from '../config/endpoints'
import {
    DefaultGraphResponse,
    PublishDefaultGraphRequest,
    UpdateDefaultGraphRequest,
} from '../models/defaultGraph.models'

/**
 * Like the request-agents assertOk: surfaces the backend's validation reason
 * on 400 responses (bad edges/entryPoint, "already published", unknown node
 * ids on update) instead of a bare status line.
 */
async function assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return
    if (response.status === 403) {
        throw new Error('Admin access required — your account is not on the admin allowlist.')
    }
    if (response.status === 400) {
        const reason = await response
            .json()
            .then((body) => body?.error as string | undefined)
            .catch(() => undefined)
        if (reason) throw new Error(reason)
    }
    throw new Error(`${action} failed: ${response.status} ${response.statusText}`)
}

/** The system default graph, or null when none has been published yet (404). */
export async function getDefaultGraph(token: string): Promise<DefaultGraphResponse | null> {
    const response = await fetch(endpoints.defaultGraph, {
        headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status === 404) return null
    await assertOk(response, 'Loading default graph')
    return response.json()
}

export async function publishDefaultGraph(
    token: string,
    payload: PublishDefaultGraphRequest
): Promise<DefaultGraphResponse> {
    const response = await fetch(endpoints.defaultGraph, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Publishing default graph "${payload.name}"`)
    return response.json()
}

export async function updateDefaultGraph(
    token: string,
    payload: UpdateDefaultGraphRequest
): Promise<DefaultGraphResponse> {
    const response = await fetch(endpoints.defaultGraph, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, 'Updating default graph')
    return response.json()
}

/** A single admin-owned agent graph, hydrated (request agents etc.). */
export async function getAgentGraph(token: string, graphId: string): Promise<DefaultGraphResponse> {
    const response = await fetch(endpoints.agent(graphId), {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Loading agent ${graphId}`)
    return response.json()
}

/** Same update semantics as the default graph, addressed by graphId. */
export async function updateAgentGraph(
    token: string,
    graphId: string,
    payload: UpdateDefaultGraphRequest
): Promise<DefaultGraphResponse> {
    const response = await fetch(endpoints.agent(graphId), {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Updating agent ${graphId}`)
    return response.json()
}
