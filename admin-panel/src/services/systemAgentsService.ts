import { endpoints } from '../config/endpoints'
import { AgentResponse } from '../models/requestAgents.models'
import { PublishDefaultGraphRequest } from '../models/defaultGraph.models'

/**
 * POST /admin/system-agents — publishes a NON-default System-owned agent: a
 * shared template every customer sees read-only in their agent picker and
 * forks on first edit. Unlike /admin/default-graph this never changes
 * behavior for customers who don't select the new agent. Listing, editing
 * and deleting the published agent go through the regular /agents endpoints.
 */
export async function publishSystemAgent(
    token: string,
    payload: PublishDefaultGraphRequest
): Promise<AgentResponse> {
    const response = await fetch(endpoints.systemAgents, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    if (!response.ok) {
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
        throw new Error(
            `Publishing System agent "${payload.name}" failed: ${response.status} ${response.statusText}`
        )
    }
    return response.json()
}
