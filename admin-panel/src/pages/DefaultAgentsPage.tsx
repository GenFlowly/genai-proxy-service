import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth0 } from '@auth0/auth0-react'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import { AgentResponse, RequestAgentMapStatus } from '../models/requestAgents.models'
import { getDefaultGraph } from '../services/defaultGraphService'
import { deleteAgent, getAgents, getRequestAgentMap } from '../services/requestAgentsService'
import { REQUEST_TYPE_LABELS, RequestType } from '../constants/requestTypes'
import AgentManager, { generationNode } from '../components/AgentManager'

// ── Node type display helpers (mirrors the customer app's Agents page) ────────

const NODE_TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
    QUERY_ANALYZER: { icon: '🔍', label: 'Query analyzer', color: '#4f86f7' },
    QUERY_REWRITER: { icon: '✏️', label: 'Query rewriter', color: '#7c5cfc' },
    RETRIEVAL: { icon: '📦', label: 'Retrieval', color: '#2ecc71' },
    RESULT_RANKER: { icon: '📊', label: 'Result ranker', color: '#f39c12' },
    RESPONSE_GENERATOR: { icon: '💬', label: 'Response generator', color: '#e74c3c' },
    RESPONSE_GENERATOR_WITH_REFLECTION: { icon: '🪞', label: 'Reflective generator', color: '#e67e22' },
    GENERATION: { icon: '💬', label: 'Generation', color: '#e74c3c' },
    WEB_SEARCH: { icon: '🌐', label: 'Web search', color: '#16a085' },
    TOOL_EXECUTOR: { icon: '🛠️', label: 'Tool executor', color: '#8e44ad' },
    REFLECTION: { icon: '🪞', label: 'Reflection', color: '#e67e22' },
}

function getNodeMeta(nodeType: string) {
    return NODE_TYPE_META[nodeType] ?? { icon: '⚙️', label: nodeType, color: '#6b7280' }
}

/**
 * All System agents as cards (mirroring the customer app's Agents page):
 * name, node pipeline, badges for what each agent serves, edit/delete and a
 * New-agent form. Assigning agents to default actions happens on the Default
 * Actions Mapping page.
 */
export default function DefaultAgentsPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [defaultGraph, setDefaultGraph] = useState<DefaultGraphResponse | null>(null)
    const [mapStatuses, setMapStatuses] = useState<RequestAgentMapStatus[]>([])
    const [agents, setAgents] = useState<AgentResponse[]>([])
    const [formOpen, setFormOpen] = useState(false)
    const [editingAgent, setEditingAgent] = useState<AgentResponse | null>(null)
    const [actionMessage, setActionMessage] = useState<string | null>(null)
    const [actionMessageKind, setActionMessageKind] = useState<'success' | 'error' | null>(null)

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const [graph, map, agentsResponse] = await Promise.all([
                getDefaultGraph(token),
                getRequestAgentMap(token),
                getAgents(token),
            ])
            setDefaultGraph(graph)
            setMapStatuses(map.entries)
            setAgents(agentsResponse.agents)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load agents')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    /** Default-action labels this agent currently serves (via the map). */
    const servedActions = (graphId: string): string[] =>
        mapStatuses
            .filter((status) => status.ddbEntry?.graphId === graphId)
            .map(
                (status) =>
                    status.displayName ??
                    REQUEST_TYPE_LABELS[status.requestType as RequestType] ??
                    status.requestType
            )

    const startEdit = (agent: AgentResponse) => {
        setEditingAgent(agent)
        setFormOpen(true)
        setActionMessage(null)
        setActionMessageKind(null)
    }

    const closeForm = () => {
        setFormOpen(false)
        setEditingAgent(null)
    }

    const handleDelete = async (agent: AgentResponse) => {
        const mappedTo = servedActions(agent.graphId)
        const warning = mappedTo.length
            ? `\n\nWARNING: it currently serves ${mappedTo.join(', ')} — those fall back to the bundled defaults.`
            : ''
        if (!window.confirm(`Delete agent "${agent.name}" (${agent.graphId})?${warning}`)) return
        setActionMessage(null)
        setActionMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteAgent(token, agent.graphId)
            if (editingAgent?.graphId === agent.graphId) closeForm()
            setActionMessage(`Agent ${agent.graphId} deleted`)
            setActionMessageKind('success')
            await refresh()
        } catch (e) {
            setActionMessage(e instanceof Error ? e.message : 'Failed to delete agent')
            setActionMessageKind('error')
        }
    }

    if (loading) return <div className="centered">Loading agents…</div>

    // The customer-chat default graph is an agent too — include it as a card
    // even when the agents endpoint doesn't return it.
    const defaultGraphId = defaultGraph?.graphId
    const cards: AgentResponse[] = [...agents]
    if (defaultGraph && !cards.some((agent) => agent.graphId === defaultGraphId)) {
        cards.unshift({
            graphId: defaultGraph.graphId,
            name: defaultGraph.name,
            isDefault: true,
            entryPoint: defaultGraph.entryPoint,
            maxIterations: defaultGraph.maxIterations,
            edges: defaultGraph.edges,
            nodes: defaultGraph.nodes.map((node) => ({
                nodeId: node.nodeId,
                nodeType: node.nodeType,
                name: node.name,
                config: node.config,
            })),
            createdAt: defaultGraph.createdAt,
            updatedAt: defaultGraph.updatedAt,
        })
    }

    return (
        <section className="page">
            <div className="agents-header">
                <div>
                    <h1 className="agents-title">Agents</h1>
                    <p className="agents-subtitle">
                        System-published agents. Assign them to actions on the{' '}
                        <Link to="/mappings">Default Actions Mapping</Link> page.
                    </p>
                </div>
                <button
                    className="primary"
                    onClick={() => {
                        setEditingAgent(null)
                        setFormOpen((open) => !open || editingAgent !== null)
                        setActionMessage(null)
                        setActionMessageKind(null)
                    }}
                >
                    ＋ New agent
                </button>
            </div>

            {loadError && <div className="banner error">{loadError}</div>}
            {actionMessage && (
                <div className={`row-message ${actionMessageKind ?? ''}`}>{actionMessage}</div>
            )}

            {formOpen && (
                <AgentManager
                    editingAgent={editingAgent}
                    mapEntries={mapStatuses}
                    onCancel={closeForm}
                    onChanged={refresh}
                />
            )}

            <div className="agents-grid">
                {cards.map((agent) => {
                    const isChatDefault = agent.graphId === defaultGraphId
                    const actions = servedActions(agent.graphId)
                    const editable = generationNode(agent) !== null
                    const editorTarget = isChatDefault
                        ? '/default-agents/default-graph'
                        : `/default-agents/agent/${agent.graphId}`
                    return (
                        <div
                            className={`agent-card ${isChatDefault ? 'is-default' : ''}`}
                            key={agent.graphId}
                        >
                            <div className="agent-card-header">
                                <div className="agent-card-title-row">
                                    <span className="agent-card-icon">🤖</span>
                                    <div>
                                        <h2 className="agent-card-name">{agent.name}</h2>
                                        <span className="agent-card-meta">
                                            {agent.nodes.length} node(s) · max {agent.maxIterations}{' '}
                                            iteration(s)
                                        </span>
                                    </div>
                                </div>
                                <div className="agent-card-actions">
                                    {isChatDefault && (
                                        <span className="agent-badge default">Conversation Default Agent</span>
                                    )}
                                    {actions.map((label) => (
                                        <span className="agent-badge action" key={label}>
                                            {label}
                                        </span>
                                    ))}
                                    {!isChatDefault && actions.length === 0 && (
                                        <span className="agent-badge">Unassigned</span>
                                    )}
                                </div>
                            </div>

                            <div className="agent-pipeline">
                                {agent.nodes.map((node, idx) => {
                                    const meta = getNodeMeta(node.nodeType)
                                    return (
                                        <React.Fragment key={node.nodeId}>
                                            <div className="agent-pipeline-node">
                                                <span
                                                    className="agent-node-icon"
                                                    style={{
                                                        background: `${meta.color}22`,
                                                        borderColor: `${meta.color}55`,
                                                    }}
                                                >
                                                    {meta.icon}
                                                </span>
                                                <span className="agent-node-name">
                                                    {node.name || meta.label}
                                                </span>
                                                <span className="agent-node-type">{meta.label}</span>
                                            </div>
                                            {idx < agent.nodes.length - 1 && (
                                                <div className="agent-pipeline-arrow">↓</div>
                                            )}
                                        </React.Fragment>
                                    )
                                })}
                            </div>

                            <div className="agent-card-footer">
                                <Link to={editorTarget} className="back-link">
                                    Open in graph editor →
                                </Link>
                                <span className="agent-card-actions">
                                    {editable && (
                                        <button
                                            className="agent-edit-btn"
                                            onClick={() => startEdit(agent)}
                                        >
                                            ✏️ Edit
                                        </button>
                                    )}
                                    {!isChatDefault && (
                                        <button
                                            className="agent-edit-btn danger"
                                            onClick={() => void handleDelete(agent)}
                                        >
                                            Delete
                                        </button>
                                    )}
                                </span>
                            </div>
                        </div>
                    )
                })}
            </div>

            {!defaultGraph && (
                <p className="agents-subtitle">
                    No customer-chat default graph published yet —{' '}
                    <Link to="/default-agents/default-graph">create it in the graph editor</Link>.
                </p>
            )}
        </section>
    )
}
