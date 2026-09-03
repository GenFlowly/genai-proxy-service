// Mirrors of the backend DTOs for the pre-made node presets endpoints
// (/api/v1/node-presets and /api/v1/admin/node-presets).

export interface NodePresetResponse {
    presetId: string
    name: string
    nodeType: string
    description: string
    /** JSON string used as the config of nodes dropped from this preset. */
    config: string
    requiredAttributes: string[]
    sortOrder: number
    createdAt?: string | null
    updatedAt?: string | null
}

export interface ListNodePresetsResponse {
    presets: NodePresetResponse[]
}

/** Body of both POST /admin/node-presets and PUT /admin/node-presets/{presetId}. */
export interface NodePresetPayload {
    name: string
    nodeType: string
    description: string
    config: string
    requiredAttributes: string[]
    sortOrder: number
}
