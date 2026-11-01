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
import { queryClient } from '../queryClient'
import {
    AGENT_DETAIL_QUERY_KEY,
    CUSTOMER_AGENTS_QUERY_KEY,
    REQUEST_AGENTS_QUERY_KEY,
} from '../hooks/queries/queryKeys'
import { customerAgentsCache } from './defaultsCacheService'

// Mutations return the full hydrated agent, so the caches are updated locally
// here — no refetch round trip, and no call site can forget. The version-gated
// list refreshes from the server at the next /onboard sync regardless (the
// backend bumps the agents counter on every write).
function applyAgentToCaches(agent: Agent): void {
    queryClient.setQueryData([AGENT_DETAIL_QUERY_KEY, agent.graphId], agent)
    const merge = (old: GetCustomerAgentsResponse): GetCustomerAgentsResponse => {
        if (!old?.agents) return old
        const exists = old.agents.some(a => a.graphId === agent.graphId)
        return {
            ...old,
            agents: exists
                ? old.agents.map(a => (a.graphId === agent.graphId ? agent : a))
                : [...old.agents, agent],
        }
    }
    queryClient.setQueriesData<GetCustomerAgentsResponse>(
        { queryKey: [CUSTOMER_AGENTS_QUERY_KEY] },
        (old: GetCustomerAgentsResponse | undefined) => (old ? merge(old) : old)
    )
    customerAgentsCache.patchData(merge)
}

/**
 * The agent as this session last saw it — detail query, else the shared
 * agents-list query. Editor pages paint this instantly while getAgent
 * revalidates. Null = never seen this session.
 */
export function getCachedAgent(graphId: string): Agent | null {
    const detail = queryClient.getQueryData<Agent>([AGENT_DETAIL_QUERY_KEY, graphId])
    if (detail) return detail
    const lists = queryClient.getQueriesData<GetCustomerAgentsResponse>({ queryKey: [CUSTOMER_AGENTS_QUERY_KEY] })
    for (const [, data] of lists) {
        const hit = data?.agents?.find(a => a.graphId === graphId)
        if (hit) return hit
    }
    return null
}

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

    const agent = (await response.json()) as Agent
    queryClient.setQueryData([AGENT_DETAIL_QUERY_KEY, agent.graphId], agent)
    return agent
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

    const created = (await response.json()) as CreateGraphAgentResponse
    applyAgentToCaches(created)
    return created
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

    const updated = (await response.json()) as UpdateAgentResponse
    applyAgentToCaches(updated)
    return updated
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

    const fork = (await response.json()) as ForkAgentResponse
    applyAgentToCaches(fork)
    // Forking a mapped System agent mirrors its SYSTEM map entries as
    // customer-scope overrides pointing at the fork — the mapping list itself
    // changed server-side, so it must refetch.
    void queryClient.invalidateQueries({ queryKey: [REQUEST_AGENTS_QUERY_KEY] })
    return fork
}
