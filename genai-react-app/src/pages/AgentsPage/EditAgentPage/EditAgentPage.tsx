import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Navbar from '../../../components/navbar/Navbar'
import { useLayout } from '../../../context/LayoutContext'
import { usePageTitle } from '../../../hooks/usePageTitle'
import { useAuth } from '../../../context/AuthContext'
import { getCustomerAgents, updateAgent } from '../../../services/agentsService'
import { Agent, AgentNode, UpdateAgentNodePatch, UpdateAgentRequest } from '../../../models/agents.models'
import styles from './EditAgentPage.module.scss'
import { formatServerDateTime } from '../../../utils/timeUtils'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
                {configInvalid && <span className={styles.nodeEditorBadgeError}>Invalid JSON</span>}
                <span className={styles.nodeEditorChevron}>{open ? '▲' : '▼'}</span>
            </button>

            {open && (
                <div className={styles.nodeEditorBody}>
                    <div className={styles.fieldRow}>
                        <div className={styles.fieldGroup}>
                            <label className={styles.fieldLabel}>Node Name</label>
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
                                    <label className={styles.fieldLabel} htmlFor={`system-prompt-${node.nodeId}`}>System Prompt</label>
                                    <textarea
                                        id={`system-prompt-${node.nodeId}`}
                                        className={styles.fieldTextarea}
                                        rows={6}
                                        value={systemPrompt}
                                        onChange={e => updateConfigField('system_prompt', e.target.value)}
                                        placeholder="You are a helpful assistant."
                                    />
                                </div>
                            )}
                            {isResponseNode && (
                                <p className={styles.fieldHint}>
                                    The system prompt and model for this node come from the instruction
                                    and model selected at request time.
                                </p>
                            )}
                            <div className={styles.fieldRow2}>
                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel}>Input Template</label>
                                    <textarea
                                        className={styles.fieldTextarea}
                                        rows={3}
                                        value={inputTemplate}
                                        onChange={e => updateConfigField('input_template', e.target.value)}
                                        placeholder="{query}"
                                    />
                                    <p className={styles.fieldHint}>
                                        Placeholders: <code>{'{query}'}</code> <code>{'{context}'}</code> <code>{'{chunks_text}'}</code>
                                    </p>
                                </div>
                                {!isResponseNode && (
                                    <div className={styles.fieldGroup}>
                                        <label className={styles.fieldLabel}>
                                            Model Override <span className={styles.optional}>(optional)</span>
                                        </label>
                                        <input
                                            type="text"
                                            className={styles.fieldInput}
                                            value={modelOverride}
                                            onChange={e => updateConfigField('model_override', e.target.value)}
                                            placeholder="e.g. gpt-4o, claude-sonnet-4-5"
                                        />
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel} htmlFor={`raw-config-${node.nodeId}`}>
                            Raw Config JSON
                            {configInvalid && <span className={styles.jsonError}> — invalid JSON</span>}
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
                    setLoadError('Agent not found.')
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
                if (!cancelled) setLoadError(err.message ?? 'Failed to load agent')
            }
        }
        load()
        return () => { cancelled = true }
    }, [graphId, getAccessTokenSilently])

    // ── Save handler ──────────────────────────────────────────────────────────

    const handleSave = useCallback(async () => {
        if (!agent) return
        setSaveError(null)
        setSaved(false)

        // Client-side validation
        if (!name.trim()) { setSaveError('Agent name must not be blank.'); return }
        if (maxIterations < 1 || maxIterations > 100) { setSaveError('Max iterations must be between 1 and 100.'); return }
        for (const node of agent.nodes) {
            const cfg = nodePatchConfigs[node.nodeId] ?? ''
            if (cfg && !isValidJson(cfg)) {
                setSaveError(`Node "${nodePatchNames[node.nodeId] || node.name}" has invalid JSON config.`)
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
            setSaveError(err.message ?? 'Failed to save agent')
        } finally {
            setSaving(false)
        }
    }, [agent, name, maxIterations, nodePatchNames, nodePatchConfigs, getAccessTokenSilently, navigate])

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
                            ← Back to Agents
                        </button>
                        {agent && (
                            <div className={styles.topBarTitle}>
                                <span className={styles.topBarIcon}>🤖</span>
                                <div>
                                    <h1 className={styles.topBarName}>{agent.name}</h1>
                                    <p className={styles.topBarMeta}>
                                        {agent.nodes.length} nodes · max {agent.maxIterations} iterations
                                        {agent.isDefault && <span className={styles.defaultBadge}>Default</span>}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className={styles.topBarActions}>
                        {saved && (
                            <span className={styles.savedBadge}>✓ Saved</span>
                        )}
                        {saveError && (
                            <span className={styles.errorBadge} title={saveError}>⚠️ Error</span>
                        )}
                        <button
                            type="button"
                            className={styles.cancelBtn}
                            onClick={() => navigate('/agents')}
                            disabled={saving}
                        >
                            Discard
                        </button>
                        <button
                            type="button"
                            className={styles.saveBtn}
                            onClick={handleSave}
                            disabled={saving || !agent}
                        >
                            {saving
                                ? <><span className={styles.savingSpinner} />Saving…</>
                                : 'Save Changes'
                            }
                        </button>
                    </div>
                </div>

                {/* Content area */}
                {!agent && !loadError && (
                    <div className={styles.stateContainer}>
                        <div className={styles.spinner} />
                        <p className={styles.stateText}>Loading agent…</p>
                    </div>
                )}

                {loadError && (
                    <div className={styles.stateContainer}>
                        <span className={styles.stateIcon}>⚠️</span>
                        <p className={styles.stateText}>{loadError}</p>
                        <button className={styles.saveBtn} onClick={() => navigate('/agents')} type="button">
                            Back to Agents
                        </button>
                    </div>
                )}

                {agent && (
                    <div className={styles.editLayout}>
                        {/* ── Left column: agent-level settings ── */}
                        <aside className={styles.sidebar}>
                            <div className={styles.sidebarCard}>
                                <h2 className={styles.cardTitle}>Agent Settings</h2>

                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel} htmlFor="agent-name">Name</label>
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
                                        Max Iterations
                                        <span className={styles.fieldHintInline}> (1–100)</span>
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
                                        <span className={styles.graphMetaLabel}>Graph ID</span>
                                        <code className={styles.graphMetaValue}>{agent.graphId}</code>
                                    </div>
                                    <div className={styles.graphMetaRow}>
                                        <span className={styles.graphMetaLabel}>Entry point</span>
                                        <code className={styles.graphMetaValue}>{agent.entryPoint}</code>
                                    </div>
                                    {agent.updatedAt && (
                                        <div className={styles.graphMetaRow}>
                                            <span className={styles.graphMetaLabel}>Last saved</span>
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
                                    <h2 className={styles.cardTitle}>Node Configuration</h2>
                                    <p className={styles.cardSubtitle}>
                                        Expand any node to edit its name, system prompt, or full config JSON.
                                        Node order follows the pipeline defined by the graph's edges.
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
