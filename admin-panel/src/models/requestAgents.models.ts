// Mirrors of the backend DTOs in genai-proxy-server models/api/
// RequestAgentMapModels.kt, CreateAgentRequest.kt and GetCustomerAgentsResponse.kt.

export interface RequestAgentMapEntry {
    scope: string
    requestType: string
    mapKey: string
    graphId: string
    enabled: boolean
    updatedBy?: string | null
    createdAt?: string | null
    updatedAt?: string | null
}

export interface RequestAgentMapStatus {
    requestType: string
    /** Human-readable action name from the backend RequestType registry. */
    displayName?: string
    /** Template variables the server supplies to this action's prompts. */
    templateVariables?: string[]
    effectiveMapKey: string
    effectiveSource: 'DDB' | 'CONFIG'
    ddbEntry?: RequestAgentMapEntry | null
}

export interface GetRequestAgentMapResponse {
    entries: RequestAgentMapStatus[]
}

export interface PutRequestAgentMapRequest {
    mapKey: string
    graphId: string
    enabled: boolean
}

export interface ModelPreference {
    aiVendor: string
    model: string
}

export interface CreateAgentRequest {
    name: string
    instructionId: string
    instructionVersion?: number | null
    outputFormat: 'text' | 'json'
    modelPreference?: ModelPreference | null
    inputTemplate: string
    maxTokens?: number | null
}

export interface AgentNodeResponse {
    nodeId: string
    nodeType: string
    name: string
    config: string
}

export interface AgentResponse {
    graphId: string
    name: string
    isDefault: boolean
    entryPoint: string
    maxIterations: number
    edges: string
    nodes: AgentNodeResponse[]
    createdAt?: string | null
    updatedAt?: string | null
}

export interface GetCustomerAgentsResponse {
    agents: AgentResponse[]
}

export interface UpdateAgentNodePatch {
    nodeId: string
    name?: string
    config?: string
}

/** Partial update for PUT /v1/agents/{graphId} — absent fields keep their values. */
export interface UpdateAgentRequest {
    name?: string
    nodes?: UpdateAgentNodePatch[]
}

/** Parsed shape of a GENERATION node's config JSON (snake_case on the wire). */
export interface GenerationNodeConfig {
    instruction_id: string
    instruction_version?: number | null
    input_template?: string
    output_format?: string
    model_preference?: { vendor: string; model: string } | null
    max_tokens?: number | null
}
