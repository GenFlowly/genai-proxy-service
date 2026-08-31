import { endpoints } from '../config/endpoints'
import {
    AgentResponse,
    CreateAgentRequest,
    GetCustomerAgentsResponse,
    GetRequestAgentMapResponse,
    PutRequestAgentMapRequest,
    UpdateAgentRequest,
} from '../models/requestAgents.models'

/**
 * Like the system-api-keys assertOk, but also surfaces the backend's
 * validation reason on 400 responses — the map PUT and agent POST return the
 * exact broken link ("graph GRP… not found", "instruction INS… not found").
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

export async function getRequestAgentMap(token: string): Promise<GetRequestAgentMapResponse> {
    const response = await fetch(endpoints.requestAgentMap, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading request-agent map')
    return response.json()
}

export async function putRequestAgentMapEntry(
    token: string,
    requestType: string,
    payload: PutRequestAgentMapRequest
): Promise<void> {
    const response = await fetch(endpoints.requestAgentMapEntry(requestType), {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Saving mapping for ${requestType}`)
}

export async function deleteRequestAgentMapEntry(
    token: string,
    requestType: string
): Promise<void> {
    const response = await fetch(endpoints.requestAgentMapEntry(requestType), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Removing mapping for ${requestType}`)
}

export async function getAgents(token: string): Promise<GetCustomerAgentsResponse> {
    const response = await fetch(endpoints.agents, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading agents')
    return response.json()
}

export async function createAgent(
    token: string,
    payload: CreateAgentRequest
): Promise<AgentResponse> {
    const response = await fetch(endpoints.agents, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Creating agent "${payload.name}"`)
    return response.json()
}

export async function updateAgent(
    token: string,
    graphId: string,
    payload: UpdateAgentRequest
): Promise<AgentResponse> {
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

export async function deleteAgent(token: string, graphId: string): Promise<void> {
    const response = await fetch(endpoints.agent(graphId), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Deleting agent ${graphId}`)
}
