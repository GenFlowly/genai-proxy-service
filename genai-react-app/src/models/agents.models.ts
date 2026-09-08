export interface AgentNode {
    nodeId: string
    nodeType: string
    name: string
    config: string
    /** Display name of the instruction referenced by the node config (if any) */
    instructionName?: string | null
}

export interface Agent {
    graphId: string
    name: string
    isDefault: boolean
    entryPoint: string
    maxIterations: number
    edges: string
    nodes: AgentNode[]
    /** Serialized canvas layout for the visual graph editor */
    layout?: string
    /** True for the System-published default graph shared across customers */
    isSystem?: boolean
    /**
     * Non-null when the graph backs an internal request flow (e.g.
     * CONVERSATION_TITLE, NOTE_TITLE, INSTRUCTION_PERSONA, MEMORY_EXTRACTION).
     * Conversation agent pickers exclude these.
     */
    requestType?: string | null
    createdAt?: string
    updatedAt?: string
}

export interface GetCustomerAgentsResponse {
    agents: Agent[]
}

/**
 * The single agent the react app treats as the default: the user's explicit
 * pick (dropdown selection) when it still exists, else their own default
 * graph, else the System-published default. Exactly one agent is ever the
 * default; the Agents page badge and the picker both use this.
 */
export function effectiveDefaultAgentId(agents: Agent[], selectedAgentId: string | null): string | null {
    if (selectedAgentId && agents.some(a => a.graphId === selectedAgentId)) return selectedAgentId
    const fallback =
        agents.find(a => !a.isSystem && a.isDefault) ??
        agents.find(a => a.isSystem && a.isDefault)
    return fallback?.graphId ?? null
}

// ── Create request types ──────────────────────────────────────────────────────

export interface NewAgentNode {
    tempId: string
    nodeType: string
    name: string
    config: string
}

export interface CreateGraphAgentRequest {
    name: string
    maxIterations: number
    entryPoint: string
    edges: string
    layout?: string
    isDefault?: boolean
    nodes: NewAgentNode[]
}

/** The backend returns the created graph as a single Agent */
export type CreateGraphAgentResponse = Agent

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
    layout?: string
    nodes?: UpdateAgentNodePatch[]
    addNodes?: NewAgentNode[]
    removeNodeIds?: string[]
}

/**
 * The backend returns the same shape as a single Agent on a successful PUT.
 * NOTE: when the edited agent has isSystem=true the server forks it — the
 * response's graphId differs from the requested one and the UI must navigate
 * to the returned graphId.
 */
export type UpdateAgentResponse = Agent
