import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import i18n from '../../i18n'
import {
    Grid,
    GridCol,
    PageHeader,
    PillButton,
    ResizableSidebar,
    ScrollArea,
    SidebarListPanel,
} from '@genflowly/component-library'
import type { SidebarListGroup } from '@genflowly/component-library'
import styles from './AgentsPage.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { forkAgent, getCustomerAgents } from '../../services/agentsService'
import { AGENT_CATEGORIES, Agent, agentCategory, effectiveDefaultAgentId } from '../../models/agents.models'
import { useAI } from '../../context/AIContext'
import { formatServerDateTime } from '../../utils/timeUtils'
import AgentsCategoryNav, {
    CATEGORY_ICONS,
    CATEGORY_LABEL_KEYS,
    CategoryFilter,
    categoryCount,
} from './components/AgentsCategoryNav'

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
    /** True only for the ONE effective default agent (pick → own default → System). */
    isEffectiveDefault: boolean
    onEdit: (agent: Agent) => void
    /** System agents are read-only: View opens the editor read-only, Fork creates an editable copy. */
    onFork: (agent: Agent) => void
    forking: boolean
}

function AgentCard({ agent, isEffectiveDefault, onEdit, onFork, forking }: AgentCardProps) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)

    return (
        <div className={`${styles.card} ${isEffectiveDefault ? styles.cardDefault : ''}`}>
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
                    {isEffectiveDefault && (
                        <span className={styles.defaultBadge}>{t('agentsPage.agentCard.defaultBadge')}</span>
                    )}
                    {agent.isSystem && (
                        <span className={styles.systemBadge}>{t('agentsPage.agentCard.systemBadge')}</span>
                    )}
                    {agent.isSystem ? (
                        <>
                            <button
                                type="button"
                                className={styles.editBtn}
                                onClick={() => onEdit(agent)}
                                aria-label={t('agentsPage.agentCard.viewAriaLabel', { name: agent.name })}
                            >
                                👁️ {t('agentsPage.agentCard.view')}
                            </button>
                            <button
                                type="button"
                                className={styles.editBtn}
                                onClick={() => onFork(agent)}
                                disabled={forking}
                                aria-label={t('agentsPage.agentCard.forkAriaLabel', { name: agent.name })}
                            >
                                🔱 {t('agentsPage.agentCard.fork')}
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className={styles.editBtn}
                            onClick={() => onEdit(agent)}
                            aria-label={t('agentsPage.agentCard.editAriaLabel', { name: agent.name })}
                        >
                            ✏️ {t('agentsPage.agentCard.edit')}
                        </button>
                    )}
                </div>
            </div>

            {/* System agents are shared and read-only — forking creates an editable copy */}
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
    const { showToast } = useToast()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    usePageTitle()

    const [agents, setAgents] = useState<Agent[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [category, setCategory] = useState<CategoryFilter>('ALL')
    const [ownership, setOwnership] = useState<'all' | 'mine'>('all')
    const [forking, setForking] = useState(false)
    const { selectedAgentId } = useAI()
    const defaultId = effectiveDefaultAgentId(agents, selectedAgentId)

    const visibleAgents = useMemo(
        () =>
            agents.filter(
                a =>
                    (category === 'ALL' || agentCategory(a) === category) &&
                    (ownership === 'all' || !a.isSystem)
            ),
        [agents, category, ownership]
    )

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

    // Navigate to the full-screen edit page (read-only for System agents)
    const handleEdit = (agent: Agent) => navigate(`/agents/${agent.graphId}`)

    // Fork a System agent into an editable customer-owned copy and open it
    const handleFork = async (agent: Agent) => {
        setForking(true)
        try {
            const token = await getAccessTokenSilently()
            const fork = await forkAgent(token, agent.graphId)
            navigate(`/agents/${fork.graphId}`)
        } catch (err) {
            console.error('Failed to fork agent:', err)
            showToast(t('agentsPage.agentCard.forkFailed'))
        } finally {
            setForking(false)
        }
    }

    // Categories as a standard sidebar list (same panel the conversation and
    // memory pages use), with the live count per category.
    const categoryGroup: SidebarListGroup = {
        id: 'categories',
        label: t('agentsPage.categories.sectionLabel'),
        items: (['ALL', ...AGENT_CATEGORIES] as CategoryFilter[]).map(filter => ({
            id: filter,
            label: (
                <span className={styles.categoryItem}>
                    <span aria-hidden="true">{CATEGORY_ICONS[filter]}</span>
                    <span className={styles.categoryItemLabel}>{t(CATEGORY_LABEL_KEYS[filter])}</span>
                    <span className={styles.categoryCount}>{categoryCount(agents, filter)}</span>
                </span>
            ),
            isActive: category === filter,
            ariaCurrent: 'true' as const,
            onSelect: () => setCategory(filter),
            testId: `agents-category-${filter.toLowerCase()}`,
        })),
    }

    return (
        <div className={styles.page}>
            {/* Standard page skeleton: header band on top, then a canvas row of
                [resizable left sidebar | transparent main] */}
            {isMobile ? (
                // 📱 No navbar — a transparent overlay header floats over the
                // full-screen content; Create agent lives in its menu
                <MobileHeader
                    title={t('agentsPage.agentsPage.title')}
                    menuItems={[
                        {
                            label: t('agentsPage.agentsPage.createAgent'),
                            onClick: () => navigate('/agents/new'),
                            'data-testid': 'create-agent-button',
                        },
                    ]}
                />
            ) : (
                <>
                    <Navbar />
                    <PageHeader
                        title={t('agentsPage.agentsPage.title')}
                        subtitle={t('agentsPage.agentsPage.subtitle')}
                        actions={
                            <PillButton
                                label={t('agentsPage.agentsPage.createAgent')}
                                variant="primary"
                                onClick={() => navigate('/agents/new')}
                                data-testid="create-agent-button"
                            />
                        }
                        data-testid="agents-page-header"
                    />
                </>
            )}

            <div className={styles.layout}>
                {!isMobile && (
                    <ResizableSidebar
                        storageKey="agentsCategorySidebarWidth"
                        minWidth={180}
                        defaultWidth={216}
                        maxWidth={320}
                        data-testid="agents-category-sidebar"
                    >
                        <SidebarListPanel
                            groups={[categoryGroup]}
                            isLoading={loading}
                            hasError={false}
                            errorText=""
                            emptyText=""
                            listAriaLabel={t('agentsPage.categories.navAriaLabel')}
                            data-testid="agents-category-panel"
                        />
                    </ResizableSidebar>
                )}

                <ScrollArea className={styles.main}>
                    {/* 📱 Categories as a chip row above the tiles */}
                    {isMobile && !loading && !error && agents.length > 0 && (
                        <AgentsCategoryNav agents={agents} selected={category} onSelect={setCategory} />
                    )}

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
                        <>
                            {/* Ownership filter chips */}
                            <div className={styles.filterChips}>
                                <PillButton
                                    label={t('agentsPage.filters.allAgents')}
                                    variant={ownership === 'all' ? 'primary' : 'secondary'}
                                    onClick={() => setOwnership('all')}
                                    aria-pressed={ownership === 'all'}
                                    data-testid="agents-filter-all"
                                />
                                <PillButton
                                    label={t('agentsPage.filters.createdByMe')}
                                    variant={ownership === 'mine' ? 'primary' : 'secondary'}
                                    onClick={() => setOwnership('mine')}
                                    aria-pressed={ownership === 'mine'}
                                    data-testid="agents-filter-mine"
                                />
                            </div>

                            {visibleAgents.length === 0 ? (
                                <div className={styles.stateContainer}>
                                    <div className={styles.emptyIcon}>🤖</div>
                                    <p className={styles.stateText}>{t('agentsPage.agentsPage.noMatchesTitle')}</p>
                                    <p className={styles.stateSubText}>{t('agentsPage.agentsPage.noMatchesSubtitle')}</p>
                                </div>
                            ) : (
                                <Grid data-testid="agents-grid">
                                    {visibleAgents.map(agent => (
                                        <GridCol key={agent.graphId} span={12} md={6} lg={4}>
                                            <AgentCard
                                                agent={agent}
                                                isEffectiveDefault={agent.graphId === defaultId}
                                                onEdit={handleEdit}
                                                onFork={handleFork}
                                                forking={forking}
                                            />
                                        </GridCol>
                                    ))}
                                </Grid>
                            )}
                        </>
                    )}
                </ScrollArea>
            </div>
        </div>
    )
}
