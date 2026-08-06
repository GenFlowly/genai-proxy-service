export interface AgentNode {
    nodeId: string
    nodeType: string
    name: string
    config: string
}

export interface Agent {
    graphId: string
    name: string
    isDefault: boolean
    entryPoint: string
    maxIterations: number
    edges: string
    nodes: AgentNode[]
    createdAt?: string
    updatedAt?: string
}

export interface GetCustomerAgentsResponse {
    agents: Agent[]
}

// ── Edit request types ────────────────────────────────────────────────────────

export interface UpdateAgentNodePatch {
    nodeId: string
    name?: string
    config?: string
}

export interface UpdateAgentRequest {
    name?: string
    isDefault?: boolean
    maxIterations?: number
    entryPoint?: string
    edges?: string
    nodes?: UpdateAgentNodePatch[]
}

/** The backend returns the same shape as a single Agent on a successful PUT */
export type UpdateAgentResponse = Agent
