import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../../components/navbar/Navbar'
import styles from './AgentsPage.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useAuth } from '../../context/AuthContext'
import { getCustomerAgents } from '../../services/agentsService'
import { Agent } from '../../models/agents.models'
import { formatServerDateTime } from '../../utils/timeUtils'

// ── Node type display helpers ─────────────────────────────────────────────────

const NODE_TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
    QUERY_ANALYZER:       { icon: '🔍', label: 'Query Analyzer',        color: '#4f86f7' },
    QUERY_REWRITER:       { icon: '✏️',  label: 'Query Rewriter',        color: '#7c5cfc' },
    RETRIEVAL:            { icon: '📦', label: 'Retrieval',              color: '#2ecc71' },
    RESULT_RANKER:        { icon: '📊', label: 'Result Ranker',          color: '#f39c12' },
    RESPONSE_GENERATOR:   { icon: '💬', label: 'Response Generator',     color: '#e74c3c' },
    RESPONSE_GENERATOR_WITH_REFLECTION: { icon: '🪞', label: 'Reflective Generator', color: '#e67e22' },
}

function getNodeMeta(nodeType: string) {
    return NODE_TYPE_META[nodeType] ?? { icon: '⚙️', label: nodeType, color: '#6b7280' }
}

// ── AgentCard ─────────────────────────────────────────────────────────────────

interface AgentCardProps {
    agent: Agent
    onEdit: (agent: Agent) => void
}

function AgentCard({ agent, onEdit }: AgentCardProps) {
    const [expanded, setExpanded] = useState(false)

    return (
        <div className={`${styles.card} ${agent.isDefault ? styles.cardDefault : ''}`}>
            {/* Card header */}
            <div className={styles.cardHeader}>
                <div className={styles.cardTitleRow}>
                    <span className={styles.cardIcon}>🤖</span>
                    <div>
                        <h2 className={styles.cardName}>{agent.name}</h2>
                        <span className={styles.cardMeta}>
                            {agent.nodes.length} node{agent.nodes.length !== 1 ? 's' : ''} · max {agent.maxIterations} iterations
                        </span>
                    </div>
                </div>
                <div className={styles.cardActions}>
                    {agent.isDefault && (
                        <span className={styles.defaultBadge}>Default</span>
                    )}
                    <button
                        type="button"
                        className={styles.editBtn}
                        onClick={() => onEdit(agent)}
                        aria-label={`Edit agent ${agent.name}`}
                    >
                        ✏️ Edit
                    </button>
                </div>
            </div>

            {/* Node pipeline */}
            <div className={styles.pipeline}>
                {agent.nodes.map((node, idx) => {
                    const meta = getNodeMeta(node.nodeType)
                    return (
                        <React.Fragment key={node.nodeId}>
                            <div className={styles.pipelineNode}>
                                <span
                                    className={styles.nodeIcon}
                                    style={{ background: `${meta.color}22`, borderColor: `${meta.color}55` }}
                                >
                                    {meta.icon}
                                </span>
                                <span className={styles.nodeName}>{node.name}</span>
                                <span className={styles.nodeType}>{meta.label}</span>
                            </div>
                            {idx < agent.nodes.length - 1 && (
                                <div className={styles.pipelineArrow}>→</div>
                            )}
                        </React.Fragment>
                    )
                })}
            </div>

            {/* Collapsible details */}
            <button
                className={styles.detailsToggle}
                onClick={() => setExpanded(v => !v)}
                type="button"
                aria-expanded={expanded}
            >
                {expanded ? '▲ Hide details' : '▼ Show details'}
            </button>
            {expanded && (
                <div className={styles.details}>
                    <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>Graph ID</span>
                        <code className={styles.detailValue}>{agent.graphId}</code>
                    </div>
                    <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>Entry point</span>
                        <code className={styles.detailValue}>{agent.entryPoint}</code>
                    </div>
                    {agent.createdAt && (
                        <div className={styles.detailRow}>
                            <span className={styles.detailLabel}>Created</span>
                            <span className={styles.detailValue}>
                                {formatServerDateTime(agent.createdAt)}
                            </span>
                        </div>
                    )}
                    {agent.updatedAt && (
                        <div className={styles.detailRow}>
                            <span className={styles.detailLabel}>Last updated</span>
                            <span className={styles.detailValue}>
                                {formatServerDateTime(agent.updatedAt)}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

// ── AgentsPage ────────────────────────────────────────────────────────────────

export default function AgentsPage() {
    const navigate = useNavigate()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    usePageTitle()

    const [agents, setAgents] = useState<Agent[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    const fetchAgents = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const token = await getAccessTokenSilently()
            const data = await getCustomerAgents(token)
            setAgents(data.agents ?? [])
        } catch (err: any) {
            setError(err.message ?? 'Failed to load agents')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => { fetchAgents() }, [fetchAgents])

    // Navigate to the full-screen edit page
    const handleEdit = (agent: Agent) => navigate(`/agents/${agent.graphId}`)

    return (
        <div className={styles.page}>
            <Navbar />

            <div className={styles.content}>
                <div className={styles.pageHeader}>
                    <div>
                        <h1 className={styles.pageTitle}>My Agents</h1>
                        <p className={styles.pageSubtitle}>AI pipelines powering your conversations</p>
                    </div>
                </div>

                {loading && (
                    <div className={styles.stateContainer}>
                        <div className={styles.spinner} aria-label="Loading agents" />
                        <p className={styles.stateText}>Loading agents…</p>
                    </div>
                )}

                {!loading && error && (
                    <div className={styles.stateContainer}>
                        <div className={styles.errorIcon}>⚠️</div>
                        <p className={styles.stateText}>{error}</p>
                        <button className={styles.retryBtn} onClick={fetchAgents} type="button">Retry</button>
                    </div>
                )}

                {!loading && !error && agents.length === 0 && (
                    <div className={styles.stateContainer}>
                        <div className={styles.emptyIcon}>🤖</div>
                        <p className={styles.stateText}>No agents found</p>
                        <p className={styles.stateSubText}>
                            Agents are created automatically when you onboard. If you see this, try refreshing.
                        </p>
                    </div>
                )}

                {!loading && !error && agents.length > 0 && (
                    <div className={styles.grid}>
                        {agents.map(agent => (
                            <AgentCard key={agent.graphId} agent={agent} onEdit={handleEdit} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
