/** A pre-made palette node: a preset config on top of a runtime node type. */
export interface NodePreset {
    presetId: string
    name: string
    nodeType: string
    description: string
    /** JSON string used as the config of nodes created from this preset */
    config: string
    /** Contract lines shown on the palette item (empty → inherit the node type's contract) */
    requiredAttributes: string[]
    sortOrder: number
    createdAt?: string
    updatedAt?: string
}

export interface GetNodePresetsResponse {
    presets: NodePreset[]
}
