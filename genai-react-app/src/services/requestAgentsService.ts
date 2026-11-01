import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { queryClient } from '../queryClient'
import { CUSTOMER_AGENTS_QUERY_KEY, REQUEST_AGENTS_QUERY_KEY } from '../hooks/queries/queryKeys'

// Mapping writes also retag agents server-side (requestType / category), so
// BOTH version-gated caches must refresh now rather than at the next /onboard
// sync. Lives here so no call site can forget it.
function invalidateMappingQueries(): void {
    void queryClient.invalidateQueries({ queryKey: [REQUEST_AGENTS_QUERY_KEY] })
    void queryClient.invalidateQueries({ queryKey: [CUSTOMER_AGENTS_QUERY_KEY] })
}

// Mirrors genai-proxy-server models/api/RequestAgentMapModels.kt (customer DTOs)

export interface CustomerRequestAgentEntry {
    scope: string
    requestType: string
    mapKey: string
    graphId: string
    enabled: boolean
    updatedAt?: string | null
}

export interface CustomerRequestAgentStatus {
    requestType: string
    /** Human-readable action name from the backend RequestType registry. */
    displayName: string
    templateVariables: string[]
    /** This account's own override, when one is set. */
    entry?: CustomerRequestAgentEntry | null
    /** Name of the agent serving this action absent an override (null = built-in prompts). */
    platformAgentName?: string | null
}

export interface GetCustomerRequestAgentsResponse {
    entries: CustomerRequestAgentStatus[]
}

/** Every default action plus this account's agent override (if any). */
export async function getRequestAgents(token: string): Promise<GetCustomerRequestAgentsResponse> {
    const response = await fetchWithRetry(endpoints.getRequestAgents, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get request agents failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetCustomerRequestAgentsResponse
}

/** Point one default action at one of this account's agents. */
export async function putRequestAgentMapping(
    token: string,
    requestType: string,
    graphId: string
): Promise<void> {
    const response = await fetchWithRetry(endpoints.requestAgentMapping(requestType), {
        method: HttpMethod.PUT,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ graphId }),
    })

    if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(detail?.error || `Save mapping failed: ${response.status} ${response.statusText}`)
    }

    invalidateMappingQueries()
}

/** Remove this account's override — the action reverts to the platform default. */
export async function deleteRequestAgentMapping(token: string, requestType: string): Promise<void> {
    const response = await fetchWithRetry(endpoints.requestAgentMapping(requestType), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok && response.status !== 404) {
        throw new Error(`Remove mapping failed: ${response.status} ${response.statusText}`)
    }

    invalidateMappingQueries()
}
