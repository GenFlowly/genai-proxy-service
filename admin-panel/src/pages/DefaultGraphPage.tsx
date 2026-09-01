import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import {
    AgentGraph,
    ConditionOption,
    GraphEditor,
    InstructionOption,
    NodeCatalogEntry,
} from '@genflowly/component-library'
import {
    DefaultGraphNodeResponse,
    DefaultGraphResponse,
    GraphEdges,
    PublishDefaultGraphNode,
    UpdateDefaultGraphNodePatch,
    UpdateDefaultGraphRequest,
} from '../models/defaultGraph.models'
import { createInstruction, getCustomerInstructions } from '../services/instructionsService'
import {
    getDefaultGraph,
    publishDefaultGraph,
    updateDefaultGraph,
} from '../services/defaultGraphService'

// ─── Bootstrap payload for the first-time publish ────────────────────────────

type BootstrapInstructionKey = 'analyzer' | 'rewriter' | 'ranker'

const BOOTSTRAP_INSTRUCTIONS: {
    key: BootstrapInstructionKey
    name: string
    text: string
}[] = [
    {
        key: 'analyzer',
        name: 'Query Analyzer — default',
        text:
            'You are a query analysis expert for a vector similarity search system. ' +
            'Analyze the user query and determine the intent and whether it needs rewriting to improve retrieval. ' +
            'Return ONLY valid JSON: {"intent": "<brief description>", "needs_rewrite": <true|false>}',
    },
    {
        key: 'rewriter',
        name: 'Query Rewriter — default',
        text:
            'You are a query rewriting expert for a vector similarity search system. ' +
            'Rewrite the query to be more specific and retrievable: expand abbreviations, add missing context, clarify ambiguity. ' +
            'Return ONLY the rewritten query text, nothing else.',
    },
    {
        key: 'ranker',
        name: 'Result Ranker — default',
        text:
            'You are a result ranking expert. Given a query and retrieved document chunks, ' +
            're-rank them by relevance and remove irrelevant ones. ' +
            'Return ONLY a JSON array of 0-based indices in order of relevance (most relevant first). ' +
            'Include only indices of relevant results. Example: [2, 0, 4]',
    },
]

function bootstrapPublishRequest(ids: Record<BootstrapInstructionKey, string>) {
    return {
        name: 'Default Graph',
        maxIterations: 10,
        entryPoint: 'n1',
        edges: JSON.stringify({
            edges: [
                { from: 'n2', to: 'n3' },
                { from: 'n3', to: 'n4' },
                { from: 'n4', to: 'n5' },
                { from: 'n5', to: '__end__' },
            ],
            conditional_edges: [
                {
                    from: 'n1',
                    condition_key: 'needs_rewrite',
                    routes: { true: 'n2', false: 'n3' },
                },
            ],
        }),
        nodes: [
            {
                tempId: 'n1',
                nodeType: 'QUERY_ANALYZER',
                name: 'Query Analyzer',
                config: JSON.stringify({
                    instruction_id: ids.analyzer,
                    input_template: 'Query: {original_query}',
                    response_format: 'json',
                    json_output_mapping: {
                        intent: 'query_intent',
                        needs_rewrite: 'needs_rewrite',
                    },
                }),
            },
            {
                tempId: 'n2',
                nodeType: 'QUERY_REWRITER',
                name: 'Query Rewriter',
                config: JSON.stringify({
                    instruction_id: ids.rewriter,
                    input_template: 'Original query: {original_query}\nIntent: {query_intent}',
                    output_key: 'rewritten_query',
                    response_format: 'text',
                }),
            },
            {
                tempId: 'n3',
                nodeType: 'RETRIEVAL',
                name: 'Retrieval',
                config: JSON.stringify({}),
            },
            {
                tempId: 'n4',
                nodeType: 'RESULT_RANKER',
                name: 'Result Ranker',
                config: JSON.stringify({
                    instruction_id: ids.ranker,
                    input_template: 'Query: {query}\n\nChunks:\n{chunks_text}',
                    output_key: 'ranked_results',
                    response_format: 'json_indices',
                    json_indices_source_key: 'retrieval_results',
                }),
            },
            {
                tempId: 'n5',
                nodeType: 'RESPONSE_GENERATOR',
                name: 'Response Generator',
                config: JSON.stringify({
                    input_template: 'Context:\n{context}\n\nQuestion: {query}',
                    output_key: 'generated_response',
                    response_format: 'text',
                    include_conversation_history: true,
                    is_streaming: true,
                }),
            },
        ],
    }
}

// ─── Visual editor catalog ───────────────────────────────────────────────────

// Default configs mirror the bootstrap publish payload above (minus the
// instruction_id, which is picked in the editor's instruction selector).
const RESPONSE_GENERATOR_DEFAULT_CONFIG = JSON.stringify({
    input_template: 'Context:\n{context}\n\nQuestion: {query}',
    output_key: 'generated_response',
    response_format: 'text',
    include_conversation_history: true,
    is_streaming: true,
})

const NODE_CATALOG: NodeCatalogEntry[] = [
    {
        nodeType: 'QUERY_ANALYZER',
        label: 'Query Analyzer',
        description: 'Determines query intent and whether it needs rewriting',
        hasPrompt: true,
        defaultConfig: JSON.stringify({
            input_template: 'Query: {original_query}',
            response_format: 'json',
            json_output_mapping: {
                intent: 'query_intent',
                needs_rewrite: 'needs_rewrite',
            },
        }),
    },
    {
        nodeType: 'QUERY_REWRITER',
        label: 'Query Rewriter',
        description: 'Rewrites the query to improve retrieval',
        hasPrompt: true,
        defaultConfig: JSON.stringify({
            input_template: 'Original query: {original_query}\nIntent: {query_intent}',
            output_key: 'rewritten_query',
            response_format: 'text',
        }),
    },
    {
        nodeType: 'RETRIEVAL',
        label: 'Retrieval',
        description: 'Vector similarity search over the customer collections',
        hasPrompt: false,
        defaultConfig: JSON.stringify({}),
    },
    {
        nodeType: 'WEB_SEARCH',
        label: 'Web Search',
        description: 'Searches the web for additional context',
        hasPrompt: false,
        defaultConfig: JSON.stringify({}),
    },
    {
        nodeType: 'RESULT_RANKER',
        label: 'Result Ranker',
        description: 'Re-ranks retrieved chunks and drops irrelevant ones',
        hasPrompt: true,
        defaultConfig: JSON.stringify({
            input_template: 'Query: {query}\n\nChunks:\n{chunks_text}',
            output_key: 'ranked_results',
            response_format: 'json_indices',
            json_indices_source_key: 'retrieval_results',
        }),
    },
    {
        nodeType: 'GENERATION',
        label: 'Generation',
        description: 'General-purpose LLM generation step',
        hasPrompt: true,
        defaultConfig: JSON.stringify({
            input_template: '{original_query}',
            output_format: 'text',
        }),
    },
    {
        nodeType: 'RESPONSE_GENERATOR',
        label: 'Response Generator',
        description: 'Generates the final answer from the retrieved context',
        hasPrompt: false,
        defaultConfig: RESPONSE_GENERATOR_DEFAULT_CONFIG,
    },
    {
        nodeType: 'RESPONSE_GENERATOR_WITH_REFLECTION',
        label: 'Response Generator + Reflection',
        description: 'Generates the answer and reflects to drive conditional routing',
        hasPrompt: false,
        defaultConfig: RESPONSE_GENERATOR_DEFAULT_CONFIG,
    },
]

const CONDITION_OPTIONS: ConditionOption[] = [
    { key: 'needs_rewrite', type: 'bool', label: 'Needs rewrite' },
    { key: 'needs_more_context', type: 'bool', label: 'Needs more context' },
    { key: 'retrieval_results', type: 'list_empty', label: 'Retrieval results empty' },
    { key: 'error', type: 'bool', label: 'Error occurred' },
]

/** Ids the editor assigns to nodes created in the current session. */
const TEMP_NODE_ID_PREFIX = 'new-'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Nodes in pipeline order: walk the edges from the entry point, unreachable last. */
function nodesInEdgeOrder(graph: DefaultGraphResponse): DefaultGraphNodeResponse[] {
    let edges: GraphEdges
    try {
        edges = JSON.parse(graph.edges) as GraphEdges
    } catch {
        return graph.nodes
    }
    const next = new Map<string, string[]>()
    const link = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to])
    for (const edge of edges.edges ?? []) link(edge.from, edge.to)
    for (const conditional of edges.conditional_edges ?? []) {
        for (const to of Object.values(conditional.routes)) link(conditional.from, to)
    }
    const seen = new Set<string>()
    const queue = [graph.entryPoint]
    while (queue.length > 0) {
        const nodeId = queue.shift()!
        if (nodeId === '__end__' || seen.has(nodeId)) continue
        seen.add(nodeId)
        queue.push(...(next.get(nodeId) ?? []))
    }
    const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]))
    const ordered = [...seen].map((id) => byId.get(id)).filter((n): n is DefaultGraphNodeResponse => !!n)
    return [...ordered, ...graph.nodes.filter((node) => !seen.has(node.nodeId))]
}

function prettyJson(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
        return raw
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
function diffGraphUpdate(
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

type NodeForm = { name: string; config: string }

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DefaultGraphPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [graph, setGraph] = useState<DefaultGraphResponse | null>(null)
    const [published, setPublished] = useState(false)

    // Edit state (published view), initialized from the loaded graph
    const [graphName, setGraphName] = useState('')
    const [maxIterations, setMaxIterations] = useState('')
    const [nodeForms, setNodeForms] = useState<Record<string, NodeForm>>({})
    const [saving, setSaving] = useState(false)
    const [saveMessage, setSaveMessage] = useState<string | null>(null)
    const [saveMessageKind, setSaveMessageKind] = useState<'success' | 'error' | null>(null)

    // Visual editor state (published view)
    const [viewMode, setViewMode] = useState<'visual' | 'simple'>('visual')
    const [instructionOptions, setInstructionOptions] = useState<InstructionOption[]>([])
    const [visualSaving, setVisualSaving] = useState(false)
    const [visualError, setVisualError] = useState<string | null>(null)

    // Bootstrap state (not-published view). Created instruction ids survive a
    // failed publish so a retry reuses them instead of creating duplicates.
    const [bootstrapping, setBootstrapping] = useState(false)
    const [bootstrapError, setBootstrapError] = useState<string | null>(null)
    const [createdInstructionIds, setCreatedInstructionIds] = useState<
        Partial<Record<BootstrapInstructionKey, string>>
    >({})

    const resetForms = (loaded: DefaultGraphResponse) => {
        setGraphName(loaded.name)
        setMaxIterations(String(loaded.maxIterations))
        setNodeForms(
            Object.fromEntries(
                loaded.nodes.map((node) => [
                    node.nodeId,
                    { name: node.name, config: prettyJson(node.config) },
                ])
            )
        )
    }

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const loaded = await getDefaultGraph(token)
            setPublished(loaded !== null)
            setGraph(loaded)
            if (loaded) resetForms(loaded)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load the default graph')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Instructions for the visual editor's instruction selector.
    useEffect(() => {
        if (!published) return
        let cancelled = false
        ;(async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getCustomerInstructions(token)
                if (cancelled) return
                setInstructionOptions(
                    response.instructions.map((instruction) => ({
                        instructionId: instruction.id,
                        name: instruction.name,
                        latestVersion: instruction.version,
                        preview: instruction.instruction.slice(0, 200),
                    }))
                )
            } catch {
                // Non-fatal: the editor simply shows an empty instruction list.
            }
        })()
        return () => {
            cancelled = true
        }
    }, [published, getAccessTokenSilently])

    // The AgentGraph fed to the visual editor. Memoized because the editor
    // re-initializes (and drops unsaved work) whenever this reference changes.
    const editorGraph: AgentGraph | null = useMemo(() => {
        if (!graph) return null
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
    }, [graph])

    const handleVisualSave = async (edited: AgentGraph) => {
        if (!graph) return
        const payload = diffGraphUpdate(graph, edited)
        if (Object.keys(payload).length === 0) return
        setVisualSaving(true)
        setVisualError(null)
        try {
            const token = await getAccessTokenSilently()
            const updated = await updateDefaultGraph(token, payload)
            setGraph(updated)
            resetForms(updated)
        } catch (e) {
            setVisualError(e instanceof Error ? e.message : 'Failed to update the default graph')
        } finally {
            setVisualSaving(false)
        }
    }

    const updateNodeForm = (nodeId: string, patch: Partial<NodeForm>) =>
        setNodeForms((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }))

    // ── Diff-style update: PUT only the fields that actually changed ──
    const parsedMaxIterations = Number.parseInt(maxIterations, 10)
    const maxIterationsValid =
        Number.isInteger(parsedMaxIterations) && parsedMaxIterations >= 1
    const invalidConfigNodeIds = graph
        ? graph.nodes
              .filter((node) => canonicalJson(nodeForms[node.nodeId]?.config ?? '') === null)
              .map((node) => node.nodeId)
        : []

    const buildUpdatePayload = (): UpdateDefaultGraphRequest => {
        const payload: UpdateDefaultGraphRequest = {}
        if (!graph) return payload
        if (graphName.trim() && graphName.trim() !== graph.name) payload.name = graphName.trim()
        if (maxIterationsValid && parsedMaxIterations !== graph.maxIterations) {
            payload.maxIterations = parsedMaxIterations
        }
        const nodePatches: UpdateDefaultGraphNodePatch[] = []
        for (const node of graph.nodes) {
            const form = nodeForms[node.nodeId]
            if (!form) continue
            const patch: UpdateDefaultGraphNodePatch = { nodeId: node.nodeId }
            if (form.name.trim() && form.name.trim() !== node.name) patch.name = form.name.trim()
            const canonical = canonicalJson(form.config)
            if (canonical !== null && canonical !== canonicalJson(node.config)) {
                patch.config = canonical
            }
            if (patch.name !== undefined || patch.config !== undefined) nodePatches.push(patch)
        }
        if (nodePatches.length > 0) payload.nodes = nodePatches
        return payload
    }

    const pendingUpdate = buildUpdatePayload()
    const hasChanges = Object.keys(pendingUpdate).length > 0

    const handleSave = async () => {
        setSaving(true)
        setSaveMessage(null)
        setSaveMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            const updated = await updateDefaultGraph(token, pendingUpdate)
            setGraph(updated)
            resetForms(updated)
            setSaveMessage(
                'Default graph updated — applies to every customer without a customized agent'
            )
            setSaveMessageKind('success')
        } catch (e) {
            setSaveMessage(e instanceof Error ? e.message : 'Failed to update the default graph')
            setSaveMessageKind('error')
        } finally {
            setSaving(false)
        }
    }

    const handleRevert = () => {
        if (graph) resetForms(graph)
        setSaveMessage(null)
        setSaveMessageKind(null)
    }

    // ── First-time publish: create the three instructions, then the graph ──
    const handleBootstrap = async () => {
        setBootstrapping(true)
        setBootstrapError(null)
        const ids = { ...createdInstructionIds }
        try {
            const token = await getAccessTokenSilently()
            for (const step of BOOTSTRAP_INSTRUCTIONS) {
                if (ids[step.key]) continue // reuse ids from a previous failed attempt
                const created = await createInstruction(token, {
                    instruction: step.text,
                    instructionName: step.name,
                })
                ids[step.key] = created.id
                setCreatedInstructionIds({ ...ids })
            }
            await publishDefaultGraph(
                token,
                bootstrapPublishRequest(ids as Record<BootstrapInstructionKey, string>)
            )
            setCreatedInstructionIds({})
            await refresh()
        } catch (e) {
            setBootstrapError(e instanceof Error ? e.message : 'Publishing the default graph failed')
        } finally {
            setBootstrapping(false)
        }
    }

    if (loading) return <div className="centered">Loading default graph…</div>

    return (
        <section className="page">
            <h2>Default Graph</h2>
            <p className="page-description">
                The System-owned default RAG agent graph. Every customer who has not published
                their own default graph runs this one for retrieval requests.
            </p>

            <div className="banner warning">
                Changes here take effect for every customer who hasn't customized their own agent
                graph.
            </div>

            {loadError && <div className="banner error">{loadError}</div>}

            {!loadError && !published && (
                <div className="form-card">
                    <h4>Publish default RAG graph</h4>
                    <p className="page-description">
                        No system default graph is published yet. Publishing creates three prompt
                        instructions (query analyzer, query rewriter, result ranker) and a
                        five-node pipeline: Query Analyzer → Query Rewriter (when needed) →
                        Retrieval → Result Ranker → Response Generator.
                    </p>
                    <ul className="bootstrap-steps">
                        {BOOTSTRAP_INSTRUCTIONS.map((step) => (
                            <li key={step.key}>
                                {createdInstructionIds[step.key] ? '✓' : '•'} Create instruction
                                "{step.name}"
                                {createdInstructionIds[step.key] && (
                                    <span className="map-details">
                                        {' '}
                                        — created ({createdInstructionIds[step.key]})
                                    </span>
                                )}
                            </li>
                        ))}
                        <li>• Publish the "Default Graph" agent (5 nodes)</li>
                    </ul>
                    {Object.keys(createdInstructionIds).length > 0 && (
                        <p className="page-description">
                            The instructions marked ✓ were already created — retrying reuses them
                            instead of creating duplicates.
                        </p>
                    )}
                    <div className="form-actions">
                        <button
                            className="primary"
                            disabled={bootstrapping}
                            onClick={() => void handleBootstrap()}
                        >
                            {bootstrapping
                                ? 'Publishing…'
                                : Object.keys(createdInstructionIds).length > 0
                                  ? 'Retry publish (reuse created instructions)'
                                  : 'Publish default RAG graph'}
                        </button>
                    </div>
                    {bootstrapError && <div className="row-message error">{bootstrapError}</div>}
                </div>
            )}

            {graph && (
                <>
                    <div className="view-toggle">
                        <button
                            className={viewMode === 'visual' ? 'primary' : ''}
                            onClick={() => setViewMode('visual')}
                        >
                            Visual editor
                        </button>
                        <button
                            className={viewMode === 'simple' ? 'primary' : ''}
                            onClick={() => setViewMode('simple')}
                        >
                            Simple view
                        </button>
                    </div>

                    {viewMode === 'visual' && (
                        <div className="graph-editor-shell">
                            <GraphEditor
                                graph={editorGraph}
                                nodeCatalog={NODE_CATALOG}
                                instructions={instructionOptions}
                                conditionOptions={CONDITION_OPTIONS}
                                saving={visualSaving}
                                errorMessage={visualError}
                                onSave={(edited) => void handleVisualSave(edited)}
                            />
                        </div>
                    )}

                    {viewMode === 'simple' && (
                        <>
                            <div className="vendor-card">
                                <div className="vendor-card-header">
                                    <h3>{graph.name}</h3>
                                    <div className="header-pills">
                                        {graph.isSystem && (
                                            <span className="status-pill priority">System</span>
                                        )}
                                        {graph.isDefault && <span className="status-pill ok">Default</span>}
                                    </div>
                                </div>
                                <div className="map-summary">
                                    <span className="map-key">{graph.graphId}</span>
                                    <span className="map-details">
                                        entry {graph.entryPoint} · {graph.nodes.length} nodes
                                        {graph.updatedAt &&
                                            ` · updated ${new Date(graph.updatedAt).toLocaleString()}`}
                                    </span>
                                </div>
                                <div className="config-row">
                                    <label className="config-field grow">
                                        Graph name
                                        <input
                                            type="text"
                                            value={graphName}
                                            disabled={saving}
                                            onChange={(e) => setGraphName(e.target.value)}
                                        />
                                    </label>
                                    <label className="config-field">
                                        Max iterations
                                        <input
                                            type="number"
                                            min={1}
                                            value={maxIterations}
                                            disabled={saving}
                                            onChange={(e) => setMaxIterations(e.target.value)}
                                        />
                                    </label>
                                </div>
                                {!maxIterationsValid && (
                                    <div className="row-message error">
                                        Max iterations must be a whole number of at least 1
                                    </div>
                                )}
                            </div>

                            <h3 className="section-heading">Pipeline</h3>
                            <p className="page-description">
                                Nodes in execution order. Edit a node's name or config JSON, then save —
                                only the changed fields are sent.
                            </p>

                            <div className="vendor-list">
                                {nodesInEdgeOrder(graph).map((node, index) => {
                                    const form = nodeForms[node.nodeId] ?? {
                                        name: node.name,
                                        config: node.config,
                                    }
                                    const configInvalid = invalidConfigNodeIds.includes(node.nodeId)
                                    return (
                                        <div className="vendor-card" key={node.nodeId}>
                                            <div className="vendor-card-header">
                                                <h3>
                                                    {index + 1}. {node.name}
                                                </h3>
                                                <div className="header-pills">
                                                    <span className="status-pill">{node.nodeType}</span>
                                                </div>
                                            </div>
                                            <div className="map-summary">
                                                <span className="map-key">{node.nodeId}</span>
                                                {node.instructionName && (
                                                    <span className="map-details">
                                                        instruction: {node.instructionName}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="config-row">
                                                <label className="config-field grow">
                                                    Node name
                                                    <input
                                                        type="text"
                                                        value={form.name}
                                                        disabled={saving}
                                                        onChange={(e) =>
                                                            updateNodeForm(node.nodeId, {
                                                                name: e.target.value,
                                                            })
                                                        }
                                                    />
                                                </label>
                                            </div>
                                            <details className="node-config">
                                                <summary>Config JSON</summary>
                                                <textarea
                                                    rows={8}
                                                    spellCheck={false}
                                                    value={form.config}
                                                    disabled={saving}
                                                    onChange={(e) =>
                                                        updateNodeForm(node.nodeId, {
                                                            config: e.target.value,
                                                        })
                                                    }
                                                />
                                                {configInvalid && (
                                                    <div className="row-message error">
                                                        Config must be valid JSON
                                                    </div>
                                                )}
                                            </details>
                                        </div>
                                    )
                                })}
                            </div>

                            <div className="form-actions default-graph-actions">
                                <button disabled={saving || !hasChanges} onClick={handleRevert}>
                                    Revert
                                </button>
                                <button
                                    className="primary"
                                    disabled={
                                        saving ||
                                        !hasChanges ||
                                        !maxIterationsValid ||
                                        invalidConfigNodeIds.length > 0
                                    }
                                    onClick={() => void handleSave()}
                                >
                                    {saving ? 'Saving…' : 'Save changes'}
                                </button>
                            </div>
                            {saveMessage && (
                                <div className={`row-message ${saveMessageKind ?? ''}`}>{saveMessage}</div>
                            )}
                        </>
                    )}
                </>
            )}
        </section>
    )
}
