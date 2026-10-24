import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    Agent,
    CreateGraphAgentRequest,
    CreateGraphAgentResponse,
    ForkAgentResponse,
    GetCustomerAgentsResponse,
    UpdateAgentRequest,
    UpdateAgentResponse,
} from '../models/agents.models'
import { fetchWithRetry } from '../utils/apiUtils'

export async function getCustomerAgents(token: string): Promise<GetCustomerAgentsResponse> {
    const response = await fetchWithRetry(endpoints.getCustomerAgents, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Customer Agents failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetCustomerAgentsResponse
}

export async function getAgent(token: string, graphId: string): Promise<Agent> {
    const response = await fetchWithRetry(endpoints.getAgent(graphId), {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get Agent failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as Agent
}

export async function createGraphAgent(
    token: string,
    req: CreateGraphAgentRequest,
): Promise<CreateGraphAgentResponse> {
    const response = await fetchWithRetry(endpoints.createAgentGraph, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(req),
    })

    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body?.error ?? `Create graph agent failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as CreateGraphAgentResponse
}

export async function updateAgent(
    token: string,
    graphId: string,
    req: UpdateAgentRequest,
): Promise<UpdateAgentResponse> {
    const response = await fetchWithRetry(`${endpoints.getCustomerAgents}/${graphId}`, {
        method: HttpMethod.PUT,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(req),
    })

    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body?.error ?? `Update agent failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as UpdateAgentResponse
}

/**
 * Forks a System (shared) agent into a customer-owned editable copy named
 * `<agent-name>-<version>-forked`. The only way to derive an editable copy —
 * System agents reject direct edits with 403.
 */
export async function forkAgent(token: string, graphId: string): Promise<ForkAgentResponse> {
    const response = await fetchWithRetry(endpoints.forkAgent(graphId), {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body?.error ?? `Fork agent failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as ForkAgentResponse
}
