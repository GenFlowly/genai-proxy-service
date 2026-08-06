import React, { useEffect, useRef, useState } from 'react'
import { Agent, AgentNode, UpdateAgentNodePatch, UpdateAgentRequest } from '../../../models/agents.models'
import styles from './EditAgentDrawer.module.scss'

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
    try {
        return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
        return raw
    }
}

function isValidJson(s: string): boolean {
    try { JSON.parse(s); return true } catch { return false }
}

// ── NodeConfigEditor ─────────────────────────────────────────────────────────

interface NodeConfigEditorProps {
    node: AgentNode
    patchName: string
    patchConfig: string
    onNameChange: (val: string) => void
    onConfigChange: (val: string) => void
}

function NodeConfigEditor({ node, patchName, patchConfig, onNameChange, onConfigChange }: NodeConfigEditorProps) {
    const [open, setOpen] = useState(false)
    const meta = getNodeMeta(node.nodeType)
    const configInvalid = patchConfig.trim() !== '' && !isValidJson(patchConfig)

    // Parse config to extract known keys for friendly editing
    let parsedConfig: Record<string, any> = {}
    try { parsedConfig = JSON.parse(patchConfig || '{}') } catch {}

    const systemPrompt: string = parsedConfig.system_prompt ?? ''
    const inputTemplate: string = parsedConfig.input_template ?? ''
    const modelOverride: string = parsedConfig.model_override ?? ''

    const updateConfigField = (key: string, value: string) => {
        const updated = { ...parsedConfig, [key]: value }
        // Remove the key entirely if value is blank
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
                <span className={styles.nodeEditorChevron}>{open ? '▲' : '▼'}</span>
            </button>

            {open && (
                <div className={styles.nodeEditorBody}>
                    {/* Node name */}
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

                    {/* Friendly system_prompt field (only for LLM nodes) */}
                    {node.nodeType !== 'RETRIEVAL' && (
                        <>
                            <div className={styles.fieldGroup}>
                                <label className={styles.fieldLabel}>System Prompt</label>
                                <textarea
                                    className={styles.fieldTextarea}
                                    rows={5}
                                    value={systemPrompt}
                                    onChange={e => updateConfigField('system_prompt', e.target.value)}
                                    placeholder="You are a helpful assistant."
                                />
                            </div>
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
                                    Use <code>{'{query}'}</code>, <code>{'{context}'}</code>, <code>{'{chunks_text}'}</code> as placeholders.
                                </p>
                            </div>
                            <div className={styles.fieldGroup}>
                                <label className={styles.fieldLabel}>Model Override <span className={styles.optional}>(optional)</span></label>
                                <input
                                    type="text"
                                    className={styles.fieldInput}
                                    value={modelOverride}
                                    onChange={e => updateConfigField('model_override', e.target.value)}
                                    placeholder="e.g. gpt-4o, claude-sonnet-4-5"
                                />
                            </div>
                        </>
                    )}

                    {/* Raw JSON editor */}
                    <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel}>
                            Raw Config JSON
                            {configInvalid && <span className={styles.jsonError}> — invalid JSON</span>}
                        </label>
                        <textarea
                            className={`${styles.fieldTextarea} ${styles.monoFont} ${configInvalid ? styles.fieldError : ''}`}
                            rows={8}
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

// ── EditAgentDrawer ──────────────────────────────────────────────────────────

export interface EditAgentDrawerProps {
    agent: Agent | null
    saving: boolean
    serverError: string | null
    onClose: () => void
    onSave: (graphId: string, req: UpdateAgentRequest) => Promise<void>
}

export default function EditAgentDrawer({
    agent,
    saving,
    serverError,
    onClose,
    onSave,
}: EditAgentDrawerProps) {
    // ── Local form state ─────────────────────────────────────────────────────
    const [name, setName] = useState('')
    const [maxIterations, setMaxIterations] = useState<number>(10)
    const [nodePatchNames, setNodePatchNames] = useState<Record<string, string>>({})
    const [nodePatchConfigs, setNodePatchConfigs] = useState<Record<string, string>>({})
    const [validationError, setValidationError] = useState<string | null>(null)

    const drawerRef = useRef<HTMLDivElement>(null)

    // Populate form whenever the target agent changes
    useEffect(() => {
        if (!agent) return
        setName(agent.name)
        setMaxIterations(agent.maxIterations)
        setValidationError(null)
        const names: Record<string, string> = {}
        const configs: Record<string, string> = {}
        agent.nodes.forEach(n => {
            names[n.nodeId] = n.name
            configs[n.nodeId] = tryPrettyJson(n.config)
        })
        setNodePatchNames(names)
        setNodePatchConfigs(configs)
    }, [agent])

    // Close on Escape key
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onClose])

    if (!agent) return null

    // ── Submit ───────────────────────────────────────────────────────────────
    const handleSave = async () => {
        setValidationError(null)

        // Client-side validation
        if (!name.trim()) {
            setValidationError('Agent name must not be blank.')
            return
        }
        if (maxIterations < 1 || maxIterations > 100) {
            setValidationError('Max iterations must be between 1 and 100.')
            return
        }
        for (const node of agent.nodes) {
            const cfg = nodePatchConfigs[node.nodeId] ?? ''
            if (cfg && !isValidJson(cfg)) {
                setValidationError(`Config for node "${nodePatchNames[node.nodeId] || node.name}" is not valid JSON.`)
                return
            }
        }

        // Build node patches (only include nodes that actually changed)
        const nodes: UpdateAgentNodePatch[] = agent.nodes
            .map(n => {
                const newName = nodePatchNames[n.nodeId] ?? n.name
                const newConfig = nodePatchConfigs[n.nodeId] ?? n.config
                const nameChanged = newName !== n.name
                const configChanged = JSON.stringify(JSON.parse(newConfig || '{}')) !== JSON.stringify(JSON.parse(n.config || '{}'))
                if (!nameChanged && !configChanged) return null
                const patch: UpdateAgentNodePatch = { nodeId: n.nodeId }
                if (nameChanged) patch.name = newName
                if (configChanged) patch.config = newConfig
                return patch
            })
            .filter((p): p is UpdateAgentNodePatch => p !== null)

        const req: UpdateAgentRequest = {}
        if (name !== agent.name) req.name = name.trim()
        if (maxIterations !== agent.maxIterations) req.maxIterations = maxIterations
        if (nodes.length > 0) req.nodes = nodes

        // Nothing changed
        if (Object.keys(req).length === 0 && nodes.length === 0) {
            onClose()
            return
        }

        await onSave(agent.graphId, req)
    }

    return (
        <>
            {/* Backdrop */}
            <div
                className={styles.backdrop}
                onClick={onClose}
                aria-hidden="true"
            />

            {/* Drawer panel */}
            <div
                ref={drawerRef}
                className={styles.drawer}
                role="dialog"
                aria-modal="true"
                aria-label={`Edit agent: ${agent.name}`}
            >
                {/* Header */}
                <div className={styles.drawerHeader}>
                    <div className={styles.drawerHeaderLeft}>
                        <span className={styles.drawerIcon}>🤖</span>
                        <div>
                            <h2 className={styles.drawerTitle}>Edit Agent</h2>
                            <p className={styles.drawerSubtitle}>{agent.name}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeBtn}
                        onClick={onClose}
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                {/* Body */}
                <div className={styles.drawerBody}>
                    {/* Agent-level fields */}
                    <section className={styles.section}>
                        <h3 className={styles.sectionTitle}>Agent Settings</h3>

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
                    </section>

                    {/* Node config section */}
                    <section className={styles.section}>
                        <h3 className={styles.sectionTitle}>Node Configuration</h3>
                        <p className={styles.sectionSubtitle}>
                            Expand each node to edit its name, system prompt, or full config JSON.
                        </p>
                        <div className={styles.nodeList}>
                            {agent.nodes.map(node => (
                                <NodeConfigEditor
                                    key={node.nodeId}
                                    node={node}
                                    patchName={nodePatchNames[node.nodeId] ?? node.name}
                                    patchConfig={nodePatchConfigs[node.nodeId] ?? tryPrettyJson(node.config)}
                                    onNameChange={val =>
                                        setNodePatchNames(prev => ({ ...prev, [node.nodeId]: val }))
                                    }
                                    onConfigChange={val =>
                                        setNodePatchConfigs(prev => ({ ...prev, [node.nodeId]: val }))
                                    }
                                />
                            ))}
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <div className={styles.drawerFooter}>
                    {(validationError || serverError) && (
                        <p className={styles.footerError}>
                            ⚠️ {validationError ?? serverError}
                        </p>
                    )}
                    <div className={styles.footerActions}>
                        <button
                            type="button"
                            className={styles.cancelBtn}
                            onClick={onClose}
                            disabled={saving}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className={styles.saveBtn}
                            onClick={handleSave}
                            disabled={saving}
                        >
                            {saving ? (
                                <><span className={styles.savingSpinner} />Saving…</>
                            ) : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </div>
        </>
    )
}
