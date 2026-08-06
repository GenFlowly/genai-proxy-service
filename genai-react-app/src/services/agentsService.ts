import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { GetCustomerAgentsResponse, UpdateAgentRequest, UpdateAgentResponse } from '../models/agents.models'
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
