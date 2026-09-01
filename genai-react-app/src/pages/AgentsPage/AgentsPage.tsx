import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import i18n from '../../i18n'
import styles from './AgentsPage.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { useAuth } from '../../context/AuthContext'
import { getCustomerAgents } from '../../services/agentsService'
import { Agent } from '../../models/agents.models'
import { formatServerDateTime } from '../../utils/timeUtils'

// ── Node type display helpers ─────────────────────────────────────────────────

const NODE_TYPE_META: Record<string, { icon: string; labelKey: string; color: string }> = {
    QUERY_ANALYZER:       { icon: '🔍', labelKey: 'agentsPage.nodeTypes.queryAnalyzer',      color: '#4f86f7' },
    QUERY_REWRITER:       { icon: '✏️',  labelKey: 'agentsPage.nodeTypes.queryRewriter',      color: '#7c5cfc' },
    RETRIEVAL:            { icon: '📦', labelKey: 'agentsPage.nodeTypes.retrieval',          color: '#2ecc71' },
    RESULT_RANKER:        { icon: '📊', labelKey: 'agentsPage.nodeTypes.resultRanker',       color: '#f39c12' },
    RESPONSE_GENERATOR:   { icon: '💬', labelKey: 'agentsPage.nodeTypes.responseGenerator',  color: '#e74c3c' },
    RESPONSE_GENERATOR_WITH_REFLECTION: { icon: '🪞', labelKey: 'agentsPage.nodeTypes.reflectiveGenerator', color: '#e67e22' },
}

function getNodeMeta(nodeType: string) {
    const meta = NODE_TYPE_META[nodeType]
    if (meta) return { icon: meta.icon, label: i18n.t(meta.labelKey), color: meta.color }
    return { icon: '⚙️', label: nodeType, color: '#6b7280' }
}

// ── AgentCard ─────────────────────────────────────────────────────────────────

interface AgentCardProps {
    agent: Agent
    onEdit: (agent: Agent) => void
}

function AgentCard({ agent, onEdit }: AgentCardProps) {
    const { t } = useTranslation()
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
                            {t('agentsPage.agentCard.meta', { count: agent.nodes.length, maxIterations: agent.maxIterations })}
                        </span>
                    </div>
                </div>
                <div className={styles.cardActions}>
                    {agent.isDefault && (
                        <span className={styles.defaultBadge}>{t('agentsPage.agentCard.defaultBadge')}</span>
                    )}
                    {agent.isSystem && (
                        <span className={styles.systemBadge}>{t('agentsPage.agentCard.systemBadge')}</span>
                    )}
                    <button
                        type="button"
                        className={styles.editBtn}
                        onClick={() => onEdit(agent)}
                        aria-label={t('agentsPage.agentCard.editAriaLabel', { name: agent.name })}
                    >
                        ✏️ {t('agentsPage.agentCard.edit')}
                    </button>
                </div>
            </div>

            {/* System default agents are shared — editing forks a private copy */}
            {agent.isSystem && (
                <p className={styles.systemHint}>{t('agentsPage.agentCard.systemHint')}</p>
            )}

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
                {expanded ? t('agentsPage.agentCard.hideDetails') : t('agentsPage.agentCard.showDetails')}
            </button>
            {expanded && (
                <div className={styles.details}>
                    <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>{t('agentsPage.agentCard.graphId')}</span>
                        <code className={styles.detailValue}>{agent.graphId}</code>
                    </div>
                    <div className={styles.detailRow}>
                        <span className={styles.detailLabel}>{t('agentsPage.agentCard.entryPoint')}</span>
                        <code className={styles.detailValue}>{agent.entryPoint}</code>
                    </div>
                    {agent.createdAt && (
                        <div className={styles.detailRow}>
                            <span className={styles.detailLabel}>{t('agentsPage.agentCard.created')}</span>
                            <span className={styles.detailValue}>
                                {formatServerDateTime(agent.createdAt)}
                            </span>
                        </div>
                    )}
                    {agent.updatedAt && (
                        <div className={styles.detailRow}>
                            <span className={styles.detailLabel}>{t('agentsPage.agentCard.lastUpdated')}</span>
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
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    const { width } = useWindowSize()
    const isMobile = width <= 768
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
            setError(err.message ?? t('agentsPage.agentsPage.loadFailed'))
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently, t])

    useEffect(() => { fetchAgents() }, [fetchAgents])

    // Navigate to the full-screen edit page
    const handleEdit = (agent: Agent) => navigate(`/agents/${agent.graphId}`)

    return (
        <div className={styles.page}>
            {/* 📱 Mobile: no navbar — a transparent overlay header floats over
                the full-screen content instead */}
            {isMobile ? <MobileHeader title={t('agentsPage.agentsPage.title')} /> : <Navbar />}

            <div className={styles.content}>
                <div className={styles.pageHeader}>
                    <div>
                        <h1 className={styles.pageTitle}>{t('agentsPage.agentsPage.title')}</h1>
                        <p className={styles.pageSubtitle}>{t('agentsPage.agentsPage.subtitle')}</p>
                    </div>
                    <button
                        type="button"
                        className={styles.createBtn}
                        onClick={() => navigate('/agents/new')}
                    >
                        ＋ {t('agentsPage.agentsPage.createAgent')}
                    </button>
                </div>

                {loading && (
                    <div className={styles.stateContainer}>
                        <div className={styles.spinner} aria-label={t('agentsPage.agentsPage.loadingAriaLabel')} />
                        <p className={styles.stateText}>{t('agentsPage.agentsPage.loading')}</p>
                    </div>
                )}

                {!loading && error && (
                    <div className={styles.stateContainer}>
                        <div className={styles.errorIcon}>⚠️</div>
                        <p className={styles.stateText}>{error}</p>
                        <button className={styles.retryBtn} onClick={fetchAgents} type="button">{t('agentsPage.agentsPage.retry')}</button>
                    </div>
                )}

                {!loading && !error && agents.length === 0 && (
                    <div className={styles.stateContainer}>
                        <div className={styles.emptyIcon}>🤖</div>
                        <p className={styles.stateText}>{t('agentsPage.agentsPage.emptyTitle')}</p>
                        <p className={styles.stateSubText}>
                            {t('agentsPage.agentsPage.emptySubtitle')}
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
