import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import Navbar from '../../../components/navbar/Navbar'
import i18n from '../../../i18n'
import { useLayout } from '../../../context/LayoutContext'
import { usePageTitle } from '../../../hooks/usePageTitle'
import { useAuth } from '../../../context/AuthContext'
import { getCustomerAgents, updateAgent } from '../../../services/agentsService'
import { Agent, AgentNode, UpdateAgentNodePatch, UpdateAgentRequest } from '../../../models/agents.models'
import styles from './EditAgentPage.module.scss'
import { formatServerDateTime } from '../../../utils/timeUtils'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function tryPrettyJson(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function isValidJson(s: string): boolean {
    try { JSON.parse(s); return true } catch { return false }
}

// ── NodeConfigEditor (accordion) ──────────────────────────────────────────────

interface NodeConfigEditorProps {
    node: AgentNode
    patchName: string
    patchConfig: string
    onNameChange: (val: string) => void
    onConfigChange: (val: string) => void
}

const RESPONSE_NODE_TYPES = new Set(['RESPONSE_GENERATOR', 'RESPONSE_GENERATOR_WITH_REFLECTION'])

function NodeConfigEditor({ node, patchName, patchConfig, onNameChange, onConfigChange }: NodeConfigEditorProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const meta = getNodeMeta(node.nodeType)
    const isResponseNode = RESPONSE_NODE_TYPES.has(node.nodeType)
    const configInvalid = patchConfig.trim() !== '' && !isValidJson(patchConfig)

    let parsedConfig: Record<string, any> = {}
    try { parsedConfig = JSON.parse(patchConfig || '{}') } catch {}

    const systemPrompt: string = parsedConfig.system_prompt ?? ''
    const inputTemplate: string = parsedConfig.input_template ?? ''
    const modelOverride: string = parsedConfig.model_override ?? ''

    const updateConfigField = (key: string, value: string) => {
        const updated = { ...parsedConfig, [key]: value }
        if (!value) delete updated[key]
        onConfigChange(JSON.stringify(updated, null, 2))
    }

    return (
        <div className={styles.nodeEditor}>
            <button
                type="button"
                className={styles.nodeEditorHeader}
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
            >
                <span
                    className={styles.nodeEditorIcon}
                    style={{ background: `${meta.color}22`, borderColor: `${meta.color}55` }}
                >
                    {meta.icon}
                </span>
                <span className={styles.nodeEditorTitle}>{patchName || node.name}</span>
                <span className={styles.nodeEditorType}>{meta.label}</span>
                {configInvalid && <span className={styles.nodeEditorBadgeError}>{t('agentsPage.nodeConfigEditor.invalidJsonBadge')}</span>}
                <span className={styles.nodeEditorChevron}>{open ? '▲' : '▼'}</span>
            </button>

            {open && (
                <div className={styles.nodeEditorBody}>
                    <div className={styles.fieldRow}>
                        <div className={styles.fieldGroup}>
                            <label className={styles.fieldLabel}>{t('agentsPage.nodeConfigEditor.nodeName')}</label>
                            <input
                                type="text"
                                className={styles.fieldInput}
                                value={patchName}
                                onChange={e => onNameChange(e.target.value)}
                                placeholder={node.name}
                            />
                        </div>
                    </div>

                    {node.nodeType !== 'RETRIEVAL' && (
                        <>
                            {!isResponseNode && (
                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel} htmlFor={`system-prompt-${node.nodeId}`}>{t('agentsPage.nodeConfigEditor.systemPrompt')}</label>
                                    <textarea
                                        id={`system-prompt-${node.nodeId}`}
                                        className={styles.fieldTextarea}
                                        rows={6}
                                        value={systemPrompt}
                                        onChange={e => updateConfigField('system_prompt', e.target.value)}
                                        placeholder={t('agentsPage.nodeConfigEditor.systemPromptPlaceholder')}
                                    />
                                </div>
                            )}
                            {isResponseNode && (
                                <p className={styles.fieldHint}>
                                    {t('agentsPage.nodeConfigEditor.responseNodeHint')}
                                </p>
                            )}
                            <div className={styles.fieldRow2}>
                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel}>{t('agentsPage.nodeConfigEditor.inputTemplate')}</label>
                                    <textarea
                                        className={styles.fieldTextarea}
                                        rows={3}
                                        value={inputTemplate}
                                        onChange={e => updateConfigField('input_template', e.target.value)}
                                        placeholder="{query}"
                                    />
                                    <p className={styles.fieldHint}>
                                        <Trans i18nKey="agentsPage.nodeConfigEditor.inputTemplatePlaceholdersList">
                                            Placeholders: <code>{'{query}'}</code> <code>{'{context}'}</code> <code>{'{chunks_text}'}</code>
                                        </Trans>
                                    </p>
                                </div>
                                {!isResponseNode && (
                                    <div className={styles.fieldGroup}>
                                        <label className={styles.fieldLabel}>
                                            {t('agentsPage.nodeConfigEditor.modelOverride')} <span className={styles.optional}>{t('agentsPage.nodeConfigEditor.optional')}</span>
                                        </label>
                                        <input
                                            type="text"
                                            className={styles.fieldInput}
                                            value={modelOverride}
                                            onChange={e => updateConfigField('model_override', e.target.value)}
                                            placeholder={t('agentsPage.nodeConfigEditor.modelOverridePlaceholder')}
                                        />
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel} htmlFor={`raw-config-${node.nodeId}`}>
                            {t('agentsPage.nodeConfigEditor.rawConfigJson')}
                            {configInvalid && <span className={styles.jsonError}> {t('agentsPage.nodeConfigEditor.invalidJsonSuffix')}</span>}
                        </label>
                        <textarea
                            id={`raw-config-${node.nodeId}`}
                            className={`${styles.fieldTextarea} ${styles.monoFont} ${configInvalid ? styles.fieldError : ''}`}
                            rows={10}
                            value={patchConfig}
                            onChange={e => onConfigChange(e.target.value)}
                            spellCheck={false}
                        />
                    </div>
                </div>
            )}
        </div>
    )
}

// ── EditAgentPage ─────────────────────────────────────────────────────────────

export default function EditAgentPage() {
    const { t } = useTranslation()
    const { graphId } = useParams<{ graphId: string }>()
    const navigate = useNavigate()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    usePageTitle()

    // Agent loading state
    const [agent, setAgent] = useState<Agent | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)

    // Form state
    const [name, setName] = useState('')
    const [maxIterations, setMaxIterations] = useState(10)
    const [nodePatchNames, setNodePatchNames] = useState<Record<string, string>>({})
    const [nodePatchConfigs, setNodePatchConfigs] = useState<Record<string, string>>({})

    // Save state
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const savedTimerRef = useRef<ReturnType<typeof setTimeout>>()

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    // Load agents list and find the one matching graphId
    useEffect(() => {
        if (!graphId) return
        let cancelled = false

        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const data = await getCustomerAgents(token)
                if (cancelled) return
                const found = data.agents.find(a => a.graphId === graphId)
                if (!found) {
                    setLoadError(t('agentsPage.editAgentPage.agentNotFound'))
                    return
                }
                setAgent(found)
                setName(found.name)
                setMaxIterations(found.maxIterations)
                const names: Record<string, string> = {}
                const configs: Record<string, string> = {}
                found.nodes.forEach(n => {
                    names[n.nodeId] = n.name
                    configs[n.nodeId] = tryPrettyJson(n.config)
                })
                setNodePatchNames(names)
                setNodePatchConfigs(configs)
            } catch (err: any) {
                if (!cancelled) setLoadError(err.message ?? t('agentsPage.editAgentPage.loadFailed'))
            }
        }
        load()
        return () => { cancelled = true }
    }, [graphId, getAccessTokenSilently, t])

    // ── Save handler ──────────────────────────────────────────────────────────

    const handleSave = useCallback(async () => {
        if (!agent) return
        setSaveError(null)
        setSaved(false)

        // Client-side validation
        if (!name.trim()) { setSaveError(t('agentsPage.editAgentPage.errorNameBlank')); return }
        if (maxIterations < 1 || maxIterations > 100) { setSaveError(t('agentsPage.editAgentPage.errorMaxIterations')); return }
        for (const node of agent.nodes) {
            const cfg = nodePatchConfigs[node.nodeId] ?? ''
            if (cfg && !isValidJson(cfg)) {
                setSaveError(t('agentsPage.editAgentPage.errorNodeConfigJson', { name: nodePatchNames[node.nodeId] || node.name }))
                return
            }
        }

        // Build diff — only send what changed
        const nodeDiffs: UpdateAgentNodePatch[] = agent.nodes
            .map(n => {
                const newName = nodePatchNames[n.nodeId] ?? n.name
                const newConfig = nodePatchConfigs[n.nodeId] ?? tryPrettyJson(n.config)
                const nameChanged = newName !== n.name
                const configChanged = newConfig !== tryPrettyJson(n.config)
                if (!nameChanged && !configChanged) return null
                const patch: UpdateAgentNodePatch = { nodeId: n.nodeId }
                if (nameChanged) patch.name = newName
                if (configChanged) patch.config = newConfig
                return patch
            })
            .filter((p): p is UpdateAgentNodePatch => p !== null)

        const req: UpdateAgentRequest = {}
        if (name.trim() !== agent.name) req.name = name.trim()
        if (maxIterations !== agent.maxIterations) req.maxIterations = maxIterations
        if (nodeDiffs.length > 0) req.nodes = nodeDiffs

        if (Object.keys(req).length === 0) { navigate('/agents'); return }

        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            const updated = await updateAgent(token, agent.graphId, req)
            setAgent(updated)
            // Refresh node patch state to match returned data
            const names: Record<string, string> = {}
            const configs: Record<string, string> = {}
            updated.nodes.forEach(n => {
                names[n.nodeId] = n.name
                configs[n.nodeId] = tryPrettyJson(n.config)
            })
            setNodePatchNames(names)
            setNodePatchConfigs(configs)
            setName(updated.name)
            setMaxIterations(updated.maxIterations)
            setSaved(true)
            clearTimeout(savedTimerRef.current)
            savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
        } catch (err: any) {
            setSaveError(err.message ?? t('agentsPage.editAgentPage.saveFailed'))
        } finally {
            setSaving(false)
        }
    }, [agent, name, maxIterations, nodePatchNames, nodePatchConfigs, getAccessTokenSilently, navigate, t])

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className={styles.page}>
            <Navbar />

            <div className={styles.body}>
                {/* Top bar */}
                <div className={styles.topBar}>
                    <div className={styles.topBarLeft}>
                        <button
                            type="button"
                            className={styles.backBtn}
                            onClick={() => navigate('/agents')}
                        >
                            {t('agentsPage.editAgentPage.backToAgents')}
                        </button>
                        {agent && (
                            <div className={styles.topBarTitle}>
                                <span className={styles.topBarIcon}>🤖</span>
                                <div>
                                    <h1 className={styles.topBarName}>{agent.name}</h1>
                                    <p className={styles.topBarMeta}>
                                        {t('agentsPage.editAgentPage.topBarMeta', { count: agent.nodes.length, maxIterations: agent.maxIterations })}
                                        {agent.isDefault && <span className={styles.defaultBadge}>{t('agentsPage.editAgentPage.defaultBadge')}</span>}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className={styles.topBarActions}>
                        {saved && (
                            <span className={styles.savedBadge}>{t('agentsPage.editAgentPage.savedBadge')}</span>
                        )}
                        {saveError && (
                            <span className={styles.errorBadge} title={saveError}>{t('agentsPage.editAgentPage.errorBadge')}</span>
                        )}
                        <button
                            type="button"
                            className={styles.cancelBtn}
                            onClick={() => navigate('/agents')}
                            disabled={saving}
                        >
                            {t('agentsPage.editAgentPage.discard')}
                        </button>
                        <button
                            type="button"
                            className={styles.saveBtn}
                            onClick={handleSave}
                            disabled={saving || !agent}
                        >
                            {saving
                                ? <><span className={styles.savingSpinner} />{t('agentsPage.editAgentPage.saving')}</>
                                : t('agentsPage.editAgentPage.saveChanges')
                            }
                        </button>
                    </div>
                </div>

                {/* Content area */}
                {!agent && !loadError && (
                    <div className={styles.stateContainer}>
                        <div className={styles.spinner} />
                        <p className={styles.stateText}>{t('agentsPage.editAgentPage.loading')}</p>
                    </div>
                )}

                {loadError && (
                    <div className={styles.stateContainer}>
                        <span className={styles.stateIcon}>⚠️</span>
                        <p className={styles.stateText}>{loadError}</p>
                        <button className={styles.saveBtn} onClick={() => navigate('/agents')} type="button">
                            {t('agentsPage.editAgentPage.backToAgentsPlain')}
                        </button>
                    </div>
                )}

                {agent && (
                    <div className={styles.editLayout}>
                        {/* ── Left column: agent-level settings ── */}
                        <aside className={styles.sidebar}>
                            <div className={styles.sidebarCard}>
                                <h2 className={styles.cardTitle}>{t('agentsPage.editAgentPage.agentSettings')}</h2>

                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel} htmlFor="agent-name">{t('agentsPage.editAgentPage.nameLabel')}</label>
                                    <input
                                        id="agent-name"
                                        type="text"
                                        className={styles.fieldInput}
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                    />
                                </div>

                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel} htmlFor="agent-max-iter">
                                        {t('agentsPage.editAgentPage.maxIterations')}
                                        <span className={styles.fieldHintInline}> {t('agentsPage.editAgentPage.maxIterationsRange')}</span>
                                    </label>
                                    <input
                                        id="agent-max-iter"
                                        type="number"
                                        min={1}
                                        max={100}
                                        className={styles.fieldInput}
                                        value={maxIterations}
                                        onChange={e => setMaxIterations(Number(e.target.value))}
                                    />
                                </div>

                                {saveError && (
                                    <div className={styles.errorBox}>
                                        <span>⚠️</span>
                                        <p>{saveError}</p>
                                    </div>
                                )}

                                <div className={styles.graphMeta}>
                                    <div className={styles.graphMetaRow}>
                                        <span className={styles.graphMetaLabel}>{t('agentsPage.editAgentPage.graphId')}</span>
                                        <code className={styles.graphMetaValue}>{agent.graphId}</code>
                                    </div>
                                    <div className={styles.graphMetaRow}>
                                        <span className={styles.graphMetaLabel}>{t('agentsPage.editAgentPage.entryPoint')}</span>
                                        <code className={styles.graphMetaValue}>{agent.entryPoint}</code>
                                    </div>
                                    {agent.updatedAt && (
                                        <div className={styles.graphMetaRow}>
                                            <span className={styles.graphMetaLabel}>{t('agentsPage.editAgentPage.lastSaved')}</span>
                                            <span className={styles.graphMetaValue}>
                                                {formatServerDateTime(agent.updatedAt)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </aside>

                        {/* ── Main column: node pipeline editors ── */}
                        <main className={styles.main}>
                            <div className={styles.mainCard}>
                                <div className={styles.mainCardHeader}>
                                    <h2 className={styles.cardTitle}>{t('agentsPage.editAgentPage.nodeConfiguration')}</h2>
                                    <p className={styles.cardSubtitle}>
                                        {t('agentsPage.editAgentPage.nodeConfigurationSubtitle')}
                                    </p>
                                </div>

                                <div className={styles.nodeList}>
                                    {agent.nodes.map((node, idx) => {
                                        return (
                                            <React.Fragment key={node.nodeId}>
                                                <NodeConfigEditor
                                                    node={node}
                                                    patchName={nodePatchNames[node.nodeId] ?? node.name}
                                                    patchConfig={nodePatchConfigs[node.nodeId] ?? tryPrettyJson(node.config)}
                                                    onNameChange={val => setNodePatchNames(p => ({ ...p, [node.nodeId]: val }))}
                                                    onConfigChange={val => setNodePatchConfigs(p => ({ ...p, [node.nodeId]: val }))}
                                                />
                                                {idx < agent.nodes.length - 1 && (
                                                    <div className={styles.pipelineConnector}>
                                                        <span className={styles.pipelineConnectorLine} />
                                                        <span className={styles.pipelineConnectorArrow}>↓</span>
                                                        <span className={styles.pipelineConnectorLine} />
                                                    </div>
                                                )}
                                            </React.Fragment>
                                        )
                                    })}

                                </div>
                            </div>
                        </main>
                    </div>
                )}
            </div>
        </div>
    )
}
