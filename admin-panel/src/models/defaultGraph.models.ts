// Mirrors of the backend DTOs in genai-proxy-server models/api/ for the
// System-owned default graph endpoints (/api/v1/admin/default-graph).

export interface DefaultGraphNodeResponse {
    nodeId: string
    nodeType: string
    name: string
    config: string
    instructionName?: string | null
}

export interface DefaultGraphResponse {
    graphId: string
    name: string
    isDefault: boolean
    entryPoint: string
    maxIterations: number
    edges: string
    layout?: string | null
    isSystem: boolean
    nodes: DefaultGraphNodeResponse[]
    createdAt?: string | null
    updatedAt?: string | null
}

/** A node in the first-time publish payload. entryPoint/edges reference tempIds. */
export interface PublishDefaultGraphNode {
    tempId: string
    nodeType: string
    name: string
    config: string
}

export interface PublishDefaultGraphRequest {
    name: string
    maxIterations: number
    entryPoint: string
    edges: string
    layout?: string
    isDefault?: boolean
    /** CONVERSATION | MEMORY | TITLE_CREATOR | INSTRUCTIONS; the server defaults to CONVERSATION. */
    category?: string
    nodes: PublishDefaultGraphNode[]
}

export interface UpdateDefaultGraphNodePatch {
    nodeId: string
    name?: string
    config?: string
}

/** Partial update for PUT /admin/default-graph — absent fields keep their values. */
export interface UpdateDefaultGraphRequest {
    name?: string
    maxIterations?: number
    entryPoint?: string
    edges?: string
    layout?: string
    nodes?: UpdateDefaultGraphNodePatch[]
    addNodes?: PublishDefaultGraphNode[]
    removeNodeIds?: string[]
}

/** Parsed shape of the edges JSON stored on a graph (snake_case on the wire). */
export interface GraphEdges {
    edges?: { from: string; to: string }[]
    conditional_edges?: {
        from: string
        condition_key: string
        routes: Record<string, string>
    }[]
}
