import type {
    AgentGraph,
    ConditionOption,
    InstructionOption,
    NodeCatalogEntry,
} from '@genflowly/component-library'
import { DEFAULT_NODE_TYPE_INFOS } from '@genflowly/component-library'
import {
    DefaultGraphResponse,
    PublishDefaultGraphNode,
    UpdateDefaultGraphNodePatch,
    UpdateDefaultGraphRequest,
} from '../models/defaultGraph.models'
import { InstructionResponse } from '../models/instructions.models'
import { NodePresetResponse } from '../models/nodePresets.models'

/** Ids the editor assigns to nodes created in the current session. */
export const TEMP_NODE_ID_PREFIX = 'new-'

/**
 * Maps the server's pre-made node presets to the palette entries the visual
 * editor consumes. hasPrompt comes from the library's metadata for the
 * underlying node type; empty requiredAttributes are omitted so the entry
 * inherits the type's contract lines.
 */
export function toCatalogEntries(presets: NodePresetResponse[]): NodeCatalogEntry[] {
    return presets.map((preset) => ({
        nodeType: preset.nodeType,
        label: preset.name,
        description: preset.description,
        defaultConfig: preset.config,
        ...(preset.requiredAttributes.length > 0
            ? { requiredAttributes: preset.requiredAttributes }
            : {}),
        hasPrompt:
            DEFAULT_NODE_TYPE_INFOS.find((info) => info.nodeType === preset.nodeType)?.hasPrompt ??
            false,
    }))
}

export const CONDITION_OPTIONS: ConditionOption[] = [
    { key: 'needs_rewrite', type: 'bool', label: 'Needs rewrite' },
    { key: 'needs_more_context', type: 'bool', label: 'Needs more context' },
    { key: 'retrieval_results', type: 'list_empty', label: 'Retrieval results empty' },
    { key: 'error', type: 'bool', label: 'Error occurred' },
]

export function toInstructionOptions(instructions: InstructionResponse[]): InstructionOption[] {
    return instructions.map((instruction) => ({
        instructionId: instruction.id,
        name: instruction.name,
        latestVersion: instruction.version,
        preview: instruction.instruction.slice(0, 200),
    }))
}

/** Map a server graph response to the shape the visual editor consumes. */
export function toEditorGraph(graph: DefaultGraphResponse): AgentGraph {
    return {
        graphId: graph.graphId,
        name: graph.name,
        isDefault: graph.isDefault,
        entryPoint: graph.entryPoint,
        maxIterations: graph.maxIterations,
        edges: graph.edges,
        layout: graph.layout ?? undefined,
        nodes: graph.nodes.map((node) => ({
            nodeId: node.nodeId,
            nodeType: node.nodeType,
            name: node.name,
            config: node.config,
        })),
    }
}

/** Canonical form for change detection — null when the text is not valid JSON. */
function canonicalJson(raw: string): string | null {
    try {
        return JSON.stringify(JSON.parse(raw))
    } catch {
        return null
    }
}

/** Comparison key for JSON text: canonical when parseable, verbatim otherwise. */
function jsonKey(raw: string): string {
    return canonicalJson(raw) ?? raw
}

/**
 * Diff the graph emitted by the visual editor against the loaded server state
 * into a partial PUT payload: only changed top-level fields, name/config
 * patches for existing nodes, addNodes for editor-created `new-*` nodes, and
 * removeNodeIds for nodes that disappeared.
 */
export function diffGraphUpdate(
    base: DefaultGraphResponse,
    edited: AgentGraph
): UpdateDefaultGraphRequest {
    const payload: UpdateDefaultGraphRequest = {}
    if (edited.name !== base.name) payload.name = edited.name
    if (edited.maxIterations !== base.maxIterations) payload.maxIterations = edited.maxIterations
    if (edited.entryPoint !== base.entryPoint) payload.entryPoint = edited.entryPoint
    if (jsonKey(edited.edges) !== jsonKey(base.edges)) payload.edges = edited.edges
    if (edited.layout !== undefined && jsonKey(edited.layout) !== jsonKey(base.layout ?? '')) {
        payload.layout = edited.layout
    }

    const baseById = new Map(base.nodes.map((node) => [node.nodeId, node]))
    const nodePatches: UpdateDefaultGraphNodePatch[] = []
    const addNodes: PublishDefaultGraphNode[] = []
    for (const node of edited.nodes) {
        if (node.nodeId.startsWith(TEMP_NODE_ID_PREFIX)) {
            addNodes.push({
                tempId: node.nodeId,
                nodeType: node.nodeType,
                name: node.name,
                config: node.config,
            })
            continue
        }
        const baseNode = baseById.get(node.nodeId)
        if (!baseNode) continue
        const patch: UpdateDefaultGraphNodePatch = { nodeId: node.nodeId }
        if (node.name !== baseNode.name) patch.name = node.name
        if (jsonKey(node.config) !== jsonKey(baseNode.config)) patch.config = node.config
        if (patch.name !== undefined || patch.config !== undefined) nodePatches.push(patch)
    }
    const editedIds = new Set(edited.nodes.map((node) => node.nodeId))
    const removeNodeIds = base.nodes
        .filter((node) => !editedIds.has(node.nodeId))
        .map((node) => node.nodeId)

    if (nodePatches.length > 0) payload.nodes = nodePatches
    if (addNodes.length > 0) payload.addNodes = addNodes
    if (removeNodeIds.length > 0) payload.removeNodeIds = removeNodeIds
    return payload
}
