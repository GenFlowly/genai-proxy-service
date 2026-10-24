import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import Navbar from '../../../components/navbar/Navbar'
import i18n from '../../../i18n'
import { useLayout } from '../../../context/LayoutContext'
import { usePageTitle } from '../../../hooks/usePageTitle'
import { useAuth } from '../../../context/AuthContext'
import { forkAgent, getAgent, updateAgent } from '../../../services/agentsService'
import { createInstruction, getCustomerInstructions } from '../../../services/instructionService'
import {
    AGENT_CATEGORIES,
    Agent,
    AgentCategory,
    AgentNode,
    UpdateAgentNodePatch,
    UpdateAgentRequest,
    agentCategory,
} from '../../../models/agents.models'
import { InstructionResponse } from '../../../models/instruction.models'
import { ScrollArea } from '@genflowly/component-library'
import styles from './EditAgentPage.module.scss'
import { formatServerDateTime } from '../../../utils/timeUtils'
import { getThinkingLevelInfo } from '../../../utils/thinkingLevels'

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

/** Latest version of each instruction, for the node instruction selector */
export interface InstructionSummary {
    id: string
    name: string
    latestVersion: number
}

function toInstructionSummaries(list: InstructionResponse[]): InstructionSummary[] {
    const map = new Map<string, InstructionSummary>()
    list.forEach(inst => {
        const existing = map.get(inst.id)
        if (!existing || inst.version > existing.latestVersion) {
            map.set(inst.id, { id: inst.id, name: inst.name, latestVersion: inst.version })
        }
    })
    return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

// ── NodeConfigEditor (accordion) ──────────────────────────────────────────────

interface NodeConfigEditorProps {
    node: AgentNode
    agentName: string
    patchName: string
    patchConfig: string
    instructions: InstructionSummary[] | null
    onNameChange: (val: string) => void
    onConfigChange: (val: string) => void
    onCreateInstruction: (name: string, text: string) => Promise<InstructionResponse>
}

const RESPONSE_NODE_TYPES = new Set(['RESPONSE_GENERATOR', 'RESPONSE_GENERATOR_WITH_REFLECTION'])

function NodeConfigEditor({
    node,
    agentName,
    patchName,
    patchConfig,
    instructions,
    onNameChange,
    onConfigChange,
    onCreateInstruction,
}: NodeConfigEditorProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [pickerOpen, setPickerOpen] = useState(false)
    const [pickerQuery, setPickerQuery] = useState('')
    const [converting, setConverting] = useState(false)
    const [convertError, setConvertError] = useState<string | null>(null)
    const meta = getNodeMeta(node.nodeType)
    const isResponseNode = RESPONSE_NODE_TYPES.has(node.nodeType)
    const configInvalid = patchConfig.trim() !== '' && !isValidJson(patchConfig)

    let parsedConfig: Record<string, any> = {}
    try { parsedConfig = JSON.parse(patchConfig || '{}') } catch {}

    const instructionId: string | undefined =
        typeof parsedConfig.instruction_id === 'string' && parsedConfig.instruction_id
            ? parsedConfig.instruction_id
            : undefined
    // null / absent means "follow latest"; a number pins that version
    const instructionVersion: number | null =
        typeof parsedConfig.instruction_version === 'number' ? parsedConfig.instruction_version : null
    const legacyPrompt: string = !instructionId && typeof parsedConfig.system_prompt === 'string'
        ? parsedConfig.system_prompt
        : ''
    const inputTemplate: string = parsedConfig.input_template ?? ''
    const modelOverride: string = parsedConfig.model_override ?? ''
    const thinkingLevel: string = typeof parsedConfig.thinking_level === 'string' ? parsedConfig.thinking_level : ''
    // Response generators run on the model picked at request time, so their
    // valid values are the generic set; other nodes derive options from the
    // model override (or the generic set when no override is given).
    const thinkingInfo = getThinkingLevelInfo(isResponseNode ? undefined : modelOverride)

    const selectedInstruction = instructionId
        ? instructions?.find(inst => inst.id === instructionId)
        : undefined
    const selectedName = selectedInstruction?.name || node.instructionName || instructionId
    const instructionsLoading = instructions === null

    const updateConfigField = (key: string, value: string) => {
        const updated = { ...parsedConfig, [key]: value }
        if (!value) delete updated[key]
        onConfigChange(JSON.stringify(updated, null, 2))
    }

    // Mutate a copy of the parsed config, preserving every untouched key
    const applyConfigPatch = (mutate: (cfg: Record<string, any>) => void) => {
        const updated = { ...parsedConfig }
        mutate(updated)
        onConfigChange(JSON.stringify(updated, null, 2))
    }

    const handleSelectInstruction = (inst: InstructionSummary) => {
        applyConfigPatch(cfg => {
            cfg.instruction_id = inst.id
            delete cfg.system_prompt
            delete cfg.instruction_version // follow latest on (re)selection
        })
        setPickerOpen(false)
        setPickerQuery('')
    }

    const handleFollowLatest = () => {
        applyConfigPatch(cfg => { delete cfg.instruction_version })
    }

    const handlePinVersion = () => {
        if (!selectedInstruction) return
        applyConfigPatch(cfg => { cfg.instruction_version = selectedInstruction.latestVersion })
    }

    const handleConvertToInstruction = async () => {
        setConvertError(null)
        setConverting(true)
        try {
            const created = await onCreateInstruction(
                `${agentName} — ${patchName || node.name}`,
                legacyPrompt,
            )
            applyConfigPatch(cfg => {
                cfg.instruction_id = created.id
                delete cfg.system_prompt
                delete cfg.instruction_version // follow latest
            })
        } catch (err: any) {
            setConvertError(err?.message ?? t('agentsPage.nodeConfigEditor.convertFailed'))
        } finally {
            setConverting(false)
        }
    }

    const query = pickerQuery.trim().toLowerCase()
    const filteredInstructions = (instructions ?? []).filter(
        inst => !query || (inst.name || '').toLowerCase().includes(query),
    )

    const instructionPicker = (
        <div className={styles.instructionPicker}>
            <input
                type="text"
                className={styles.fieldInput}
                value={pickerQuery}
                onChange={e => { setPickerQuery(e.target.value); setPickerOpen(true) }}
                onFocus={() => setPickerOpen(true)}
                placeholder={t('agentsPage.nodeConfigEditor.instructionSearchPlaceholder')}
                aria-label={t('agentsPage.nodeConfigEditor.instructionSearchAriaLabel', { name: patchName || node.name })}
                data-testid={`instruction-search-${node.nodeId}`}
            />
            {pickerOpen && (
                <ScrollArea as="ul" className={styles.instructionOptionList} role="listbox">
                    {instructionsLoading && (
                        <li className={styles.instructionOptionEmpty}>{t('agentsPage.nodeConfigEditor.instructionsLoading')}</li>
                    )}
                    {!instructionsLoading && filteredInstructions.length === 0 && (
                        <li className={styles.instructionOptionEmpty}>{t('agentsPage.nodeConfigEditor.noInstructionsFound')}</li>
                    )}
                    {filteredInstructions.map(inst => (
                        <li key={inst.id}>
                            <button
                                type="button"
                                role="option"
                                aria-selected={inst.id === instructionId}
                                className={styles.instructionOption}
                                onClick={() => handleSelectInstruction(inst)}
                                data-testid={`instruction-option-${node.nodeId}-${inst.id}`}
                            >
                                <span className={styles.instructionOptionName}>
                                    {inst.name || t('common.instructionTile.untitledInstruction')}
                                </span>
                                <span className={styles.instructionOptionVersion}>v{inst.latestVersion}</span>
                            </button>
                        </li>
                    ))}
                </ScrollArea>
            )}
        </div>
    )

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
                                    <label className={styles.fieldLabel}>{t('agentsPage.nodeConfigEditor.instruction')}</label>

                                    {instructionId && (
                                        <>
                                            <div className={styles.instructionSelectedRow}>
                                                <span
                                                    className={styles.instructionSelectedName}
                                                    data-testid={`instruction-selected-${node.nodeId}`}
                                                >
                                                    📄 {selectedName}
                                                </span>
                                                <button
                                                    type="button"
                                                    className={styles.instructionChangeBtn}
                                                    onClick={() => setPickerOpen(v => !v)}
                                                >
                                                    {t('agentsPage.nodeConfigEditor.changeInstruction')}
                                                </button>
                                            </div>
                                            {pickerOpen && instructionPicker}
                                            <div className={styles.versionControl} role="radiogroup" aria-label={t('agentsPage.nodeConfigEditor.versionControlAriaLabel')}>
                                                <label className={styles.versionOption}>
                                                    <input
                                                        type="radio"
                                                        name={`instruction-version-${node.nodeId}`}
                                                        checked={instructionVersion === null}
                                                        onChange={handleFollowLatest}
                                                    />
                                                    {t('agentsPage.nodeConfigEditor.followLatest')}
                                                </label>
                                                <label className={styles.versionOption}>
                                                    <input
                                                        type="radio"
                                                        name={`instruction-version-${node.nodeId}`}
                                                        checked={instructionVersion !== null}
                                                        onChange={handlePinVersion}
                                                        disabled={instructionVersion === null && !selectedInstruction}
                                                    />
                                                    {instructionVersion !== null
                                                        ? t('agentsPage.nodeConfigEditor.pinnedToVersion', { version: instructionVersion })
                                                        : t('agentsPage.nodeConfigEditor.pinToVersion')}
                                                </label>
                                            </div>
                                        </>
                                    )}

                                    {!instructionId && legacyPrompt && (
                                        <div className={styles.legacyPromptBox}>
                                            <p className={styles.fieldHint}>{t('agentsPage.nodeConfigEditor.legacyPromptHint')}</p>
                                            <textarea
                                                className={`${styles.fieldTextarea} ${styles.legacyPromptText}`}
                                                rows={5}
                                                value={legacyPrompt}
                                                readOnly
                                                aria-label={t('agentsPage.nodeConfigEditor.legacyPromptAriaLabel')}
                                                data-testid={`legacy-prompt-${node.nodeId}`}
                                            />
                                            <div>
                                                <button
                                                    type="button"
                                                    className={styles.convertBtn}
                                                    onClick={handleConvertToInstruction}
                                                    disabled={converting}
                                                >
                                                    {converting
                                                        ? t('agentsPage.nodeConfigEditor.converting')
                                                        : t('agentsPage.nodeConfigEditor.convertToInstruction')}
                                                </button>
                                            </div>
                                            {convertError && <p className={styles.jsonError}>{convertError}</p>}
                                        </div>
                                    )}

                                    {!instructionId && !legacyPrompt && instructionPicker}
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

                            <div className={styles.fieldGroup}>
                                <label className={styles.fieldLabel} htmlFor={`thinking-level-${node.nodeId}`}>
                                    {t('agentsPage.nodeConfigEditor.thinkingLevel')} <span className={styles.optional}>{t('agentsPage.nodeConfigEditor.optional')}</span>
                                </label>
                                <select
                                    id={`thinking-level-${node.nodeId}`}
                                    className={styles.fieldInput}
                                    value={thinkingLevel}
                                    onChange={e => updateConfigField('thinking_level', e.target.value)}
                                    data-testid={`thinking-level-${node.nodeId}`}
                                >
                                    <option value="">{t('agentsPage.nodeConfigEditor.thinkingLevelDefault')}</option>
                                    {thinkingInfo.options.map(o => (
                                        <option key={o.value} value={o.value}>
                                            {t(`agentsPage.nodeConfigEditor.thinkingLevel_${o.value}`)}{o.native ? ` — ${o.native}` : ''}
                                        </option>
                                    ))}
                                    {/* A stored level the current model doesn't support stays
                                        visible so it can be seen and cleared */}
                                    {thinkingLevel && !thinkingInfo.options.some(o => o.value === thinkingLevel) && (
                                        <option value={thinkingLevel}>{thinkingLevel}</option>
                                    )}
                                </select>
                                <p className={styles.fieldHint}>
                                    {t(`agentsPage.nodeConfigEditor.thinkingHint_${thinkingInfo.options.length > 0 ? thinkingInfo.vendor : 'unsupported'}`)}
                                </p>
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

    // Instructions for the node instruction selectors (null = still loading)
    const [instructions, setInstructions] = useState<InstructionSummary[] | null>(null)

    // Form state
    const [name, setName] = useState('')
    const [maxIterations, setMaxIterations] = useState(10)
    const [category, setCategory] = useState<AgentCategory>('CONVERSATION')
    const [nodePatchNames, setNodePatchNames] = useState<Record<string, string>>({})
    const [nodePatchConfigs, setNodePatchConfigs] = useState<Record<string, string>>({})

    // Save state
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const savedTimerRef = useRef<ReturnType<typeof setTimeout>>()

    // System agents are read-only; the Fork button creates an editable copy
    const isReadOnly = !!agent?.isSystem
    const [forking, setForking] = useState(false)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    // Load the agent via the dedicated GET /agents/{graphId} endpoint
    useEffect(() => {
        if (!graphId) return
        let cancelled = false

        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const found = await getAgent(token, graphId)
                if (cancelled) return
                setAgent(found)
                setName(found.name)
                setMaxIterations(found.maxIterations)
                setCategory(agentCategory(found))
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

    // Load the customer's instructions once per page for the node selectors
    useEffect(() => {
        let cancelled = false
        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const data = await getCustomerInstructions(token)
                if (!cancelled) setInstructions(toInstructionSummaries(data.instructions ?? []))
            } catch (err) {
                console.error('Failed to load instructions', err)
                if (!cancelled) setInstructions([])
            }
        }
        load()
        return () => { cancelled = true }
    }, [getAccessTokenSilently])

    // Creates an instruction (used by "Convert to instruction") and registers
    // it in the local list so its name shows up immediately
    const handleCreateInstruction = useCallback(async (instructionName: string, text: string) => {
        const token = await getAccessTokenSilently()
        const created = await createInstruction(token, { instruction: text, instructionName })
        setInstructions(prev => [
            ...(prev ?? []).filter(inst => inst.id !== created.id),
            { id: created.id, name: created.name || instructionName, latestVersion: created.version ?? 1 },
        ])
        return created
    }, [getAccessTokenSilently])

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
        if (category !== agentCategory(agent)) req.category = category
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
            setCategory(agentCategory(updated))
            setSaved(true)
            clearTimeout(savedTimerRef.current)
            savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
        } catch (err: any) {
            setSaveError(err.message ?? t('agentsPage.editAgentPage.saveFailed'))
        } finally {
            setSaving(false)
        }
    }, [agent, name, maxIterations, category, nodePatchNames, nodePatchConfigs, getAccessTokenSilently, navigate, t])

    // Fork the read-only System agent into an editable copy and open it
    const handleFork = useCallback(async () => {
        if (!agent) return
        setForking(true)
        setSaveError(null)
        try {
            const token = await getAccessTokenSilently()
            const fork = await forkAgent(token, agent.graphId)
            navigate(`/agents/${fork.graphId}`, { replace: true })
            // Reload the form from the fork (same route component instance)
            setAgent(fork)
            setName(fork.name)
            setMaxIterations(fork.maxIterations)
            setCategory(agentCategory(fork))
            const names: Record<string, string> = {}
            const configs: Record<string, string> = {}
            fork.nodes.forEach(n => {
                names[n.nodeId] = n.name
                configs[n.nodeId] = tryPrettyJson(n.config)
            })
            setNodePatchNames(names)
            setNodePatchConfigs(configs)
        } catch (err: any) {
            setSaveError(err.message ?? t('agentsPage.editAgentPage.forkFailed'))
        } finally {
            setForking(false)
        }
    }, [agent, getAccessTokenSilently, navigate, t])

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
                                        {agent.isSystem && <span className={styles.systemBadge}>{t('agentsPage.editAgentPage.systemBadge')}</span>}
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
                            disabled={saving || forking}
                        >
                            {t('agentsPage.editAgentPage.discard')}
                        </button>
                        {isReadOnly ? (
                            <button
                                type="button"
                                className={styles.saveBtn}
                                onClick={handleFork}
                                disabled={forking}
                                data-testid="edit-agent-fork"
                            >
                                {forking
                                    ? <><span className={styles.savingSpinner} />{t('agentsPage.editAgentPage.forking')}</>
                                    : <>🔱 {t('agentsPage.editAgentPage.forkToEdit')}</>
                                }
                            </button>
                        ) : (
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
                        )}
                    </div>
                </div>

                {/* System agent — read-only banner with the fork escape hatch */}
                {isReadOnly && (
                    <div className={styles.systemBanner} role="note">
                        <span aria-hidden="true">ℹ️</span>
                        <p>{t('agentsPage.editAgentPage.systemBanner')}</p>
                    </div>
                )}

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
                    // A disabled fieldset natively disables every nested form
                    // control — System agents render read-only without each
                    // input needing its own disabled wiring.
                    <fieldset className={styles.readOnlyFieldset} disabled={isReadOnly}>
                    <div className={styles.editLayout}>
                        {/* ── Left column: agent-level settings ── */}
                        <ScrollArea as="aside" className={styles.sidebar}>
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

                                <div className={styles.fieldGroup}>
                                    <label className={styles.fieldLabel} htmlFor="agent-category">
                                        {t('agentsPage.editAgentPage.categoryLabel')}
                                    </label>
                                    <select
                                        id="agent-category"
                                        className={styles.fieldInput}
                                        value={category}
                                        onChange={e => setCategory(e.target.value as AgentCategory)}
                                        data-testid="agent-category-select"
                                    >
                                        {AGENT_CATEGORIES.map(c => (
                                            <option key={c} value={c}>
                                                {t(`agentsPage.categories.${c === 'TITLE_CREATOR' ? 'titleCreator' : c.toLowerCase()}`)}
                                            </option>
                                        ))}
                                    </select>
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
                        </ScrollArea>

                        {/* ── Main column: node pipeline editors ── */}
                        <ScrollArea as="main" className={styles.main}>
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
                                                    agentName={agent.name}
                                                    patchName={nodePatchNames[node.nodeId] ?? node.name}
                                                    patchConfig={nodePatchConfigs[node.nodeId] ?? tryPrettyJson(node.config)}
                                                    instructions={instructions}
                                                    onNameChange={val => setNodePatchNames(p => ({ ...p, [node.nodeId]: val }))}
                                                    onConfigChange={val => setNodePatchConfigs(p => ({ ...p, [node.nodeId]: val }))}
                                                    onCreateInstruction={handleCreateInstruction}
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
                        </ScrollArea>
                    </div>
                    </fieldset>
                )}
            </div>
        </div>
    )
}
