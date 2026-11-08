import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { DEFAULT_NODE_TYPE_INFOS, GraphEditor, Icon } from '@genflowly/component-library'
import type { AgentGraph, ConditionOption, InstructionOption, NodeCatalogEntry } from '@genflowly/component-library'
import Navbar from '../../../components/navbar/Navbar'
import MobileHeader from '../../../components/widgets/MobileHeader/MobileHeader'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import { usePageTitle } from '../../../hooks/usePageTitle'
import { createGraphAgent, forkAgent, getAgent, getCachedAgent, updateAgent } from '../../../services/agentsService'
import { getCustomerInstructions } from '../../../services/instructionService'
import { getNodePresets } from '../../../services/nodePresetsService'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { AGENT_EDITOR_MIN_WIDTH } from '../../../constants/breakpoints'
import { AIVendor } from '../../../constants/vendors'
import { ICONS } from '../../../constants/icons'
import { useVendorDisplayNames } from '../../../hooks/useVendorDisplayNames'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import {
    AGENT_CATEGORIES,
    Agent,
    AgentCategory,
    CreateGraphAgentRequest,
    NewAgentNode,
    UpdateAgentNodePatch,
    UpdateAgentRequest,
    agentCategory,
} from '../../../models/agents.models'
import { InstructionResponse } from '../../../models/instruction.models'
import { NodePreset } from '../../../models/nodePresets.models'
import styles from './GraphAgentEditorPage.module.scss'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Editor-created nodes carry ids with this prefix until the server assigns real ones. */
const TEMP_NODE_ID_PREFIX = 'new-'

const DESKTOP_MIN_WIDTH_QUERY = `(min-width: ${AGENT_EDITOR_MIN_WIDTH}px)`

const COPIED_LABEL_DURATION_MS = 2000

const INSTRUCTION_PREVIEW_LENGTH = 200

/** Condition keys the runtime exposes for conditional edges. */
const CONDITION_DEFS: ReadonlyArray<{ key: string; type: ConditionOption['type']; labelKey: string }> = [
    { key: 'needs_rewrite', type: 'bool', labelKey: 'agentsPage.graphEditorPage.conditions.needsRewrite' },
    { key: 'needs_more_context', type: 'bool', labelKey: 'agentsPage.graphEditorPage.conditions.needsMoreContext' },
    { key: 'retrieval_results', type: 'list_empty', labelKey: 'agentsPage.graphEditorPage.conditions.retrievalResultsEmpty' },
    { key: 'error', type: 'bool', labelKey: 'agentsPage.graphEditorPage.conditions.errorOccurred' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Latest version of each instruction as an editor InstructionOption. */
export function toInstructionOptions(list: InstructionResponse[]): InstructionOption[] {
    const byId = new Map<string, InstructionResponse>()
    list.forEach(inst => {
        const existing = byId.get(inst.id)
        if (!existing || inst.version > existing.version) byId.set(inst.id, inst)
    })
    return Array.from(byId.values())
        .map(inst => ({
            instructionId: inst.id,
            name: inst.name,
            latestVersion: inst.version,
            preview: (inst.instruction ?? '').slice(0, INSTRUCTION_PREVIEW_LENGTH),
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

/**
 * Diffs the graph emitted by the editor against the loaded agent into a
 * minimal UpdateAgentRequest: top-level fields only when changed, changed
 * existing nodes as patches, `new-*` nodes as addNodes, and loaded nodes
 * missing from the emitted graph as removeNodeIds.
 */
export function buildUpdateAgentRequest(loaded: Agent, emitted: AgentGraph): UpdateAgentRequest {
    const req: UpdateAgentRequest = {}
    if (emitted.name !== loaded.name) req.name = emitted.name
    if (emitted.maxIterations !== loaded.maxIterations) req.maxIterations = emitted.maxIterations
    if (emitted.entryPoint !== loaded.entryPoint) req.entryPoint = emitted.entryPoint
    if (emitted.edges !== loaded.edges) req.edges = emitted.edges
    if (emitted.layout !== undefined && emitted.layout !== loaded.layout) req.layout = emitted.layout

    const loadedById = new Map(loaded.nodes.map(n => [n.nodeId, n]))
    const patches: UpdateAgentNodePatch[] = []
    const addNodes: NewAgentNode[] = []

    emitted.nodes.forEach(node => {
        if (node.nodeId.startsWith(TEMP_NODE_ID_PREFIX)) {
            addNodes.push({ tempId: node.nodeId, nodeType: node.nodeType, name: node.name, config: node.config })
            return
        }
        const before = loadedById.get(node.nodeId)
        if (!before) return
        const patch: UpdateAgentNodePatch = { nodeId: node.nodeId }
        if (node.name !== before.name) patch.name = node.name
        if (node.config !== before.config) patch.config = node.config
        if (patch.name !== undefined || patch.config !== undefined) patches.push(patch)
    })

    const emittedIds = new Set(emitted.nodes.map(n => n.nodeId))
    const removeNodeIds = loaded.nodes.filter(n => !emittedIds.has(n.nodeId)).map(n => n.nodeId)

    if (patches.length > 0) req.nodes = patches
    if (addNodes.length > 0) req.addNodes = addNodes
    if (removeNodeIds.length > 0) req.removeNodeIds = removeNodeIds
    return req
}

/** Whether the viewport is wide enough for the visual editor. */
function useIsDesktop(): boolean {
    const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_MIN_WIDTH_QUERY).matches)
    useEffect(() => {
        const update = () => setIsDesktop(window.matchMedia(DESKTOP_MIN_WIDTH_QUERY).matches)
        update()
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
    }, [])
    return isDesktop
}

// ── DesktopNeededNotice ───────────────────────────────────────────────────────

/** Shown instead of the editor on small screens, with the link to open on a desktop. */
function DesktopNeededNotice({ graphId }: { graphId?: string }) {
    const { t } = useTranslation()
    const [copied, setCopied] = useState(false)
    const agentsUrl = `${window.location.origin}/agents/`
    const agentSegment = graphId ?? 'new'
    const desktopUrl = `${agentsUrl}${agentSegment}`

    useEffect(() => {
        if (!copied) return
        const timer = setTimeout(() => setCopied(false), COPIED_LABEL_DURATION_MS)
        return () => clearTimeout(timer)
    }, [copied])

    const copyUrl = async () => {
        try {
            await navigator.clipboard.writeText(desktopUrl)
            setCopied(true)
        } catch (err) {
            console.error('Failed to copy:', err)
        }
    }

    return (
        <div className={styles.mobilePage}>
            <MobileHeader title={t('agentsPage.graphEditorPage.desktopNeededTitle')} swipeBack={{ to: '/agents' }} />
            <div className={styles.mobileNotice}>
                <span className={styles.mobileNoticeIcon} aria-hidden="true">🖥️</span>
                <h1 className={styles.mobileNoticeTitle}>{t('agentsPage.graphEditorPage.desktopNeededTitle')}</h1>
                <p className={styles.mobileNoticeBody}>
                    {t(graphId ? 'agentsPage.graphEditorPage.desktopNeededEditBody' : 'agentsPage.graphEditorPage.desktopNeededCreateBody')}
                </p>
                <code className={styles.desktopUrl} data-testid="agent-desktop-url">
                    {agentsUrl}<wbr />{agentSegment}
                </code>
                <button type="button" className={styles.copyUrlBtn} onClick={copyUrl}>
                    {t(copied ? 'common.copyToClipboard.copied' : 'common.copyToClipboard.copy')}
                </button>
                <Link to="/agents" className={styles.backLink}>
                    {t('agentsPage.graphEditorPage.backToAgents')}
                </Link>
            </div>
        </div>
    )
}

// ── GraphAgentEditorPage ──────────────────────────────────────────────────────

/**
 * Full-screen visual agent editor. On desktop it renders the library's
 * GraphEditor; on small screens agents can't be opened, so it shows a notice
 * with the link to open on a desktop.
 */
export default function GraphAgentEditorPage() {
    const { t } = useTranslation()
    const vendorDisplayName = useVendorDisplayNames()
    const { graphId } = useParams<{ graphId: string }>()
    const navigate = useNavigate()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently, customerId, aiVendorAPIKeyStatusList } = useAuth()
    const isDesktop = useIsDesktop()
    const isNew = !graphId || graphId === 'new'
    usePageTitle()

    const [agent, setAgent] = useState<Agent | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [instructions, setInstructions] = useState<InstructionOption[]>([])
    const [presets, setPresets] = useState<NodePreset[]>([])
    const [saving, setSaving] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [dirty, setDirty] = useState(false)
    const [forking, setForking] = useState(false)
    // Category for NEW agents (existing agents save category changes immediately)
    const [newAgentCategory, setNewAgentCategory] = useState<AgentCategory>('CONVERSATION')

    const isReadOnly = !!agent?.isSystem

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    // Load the agent (existing graphs only) — desktop editor path. Paints the
    // session-cached copy instantly, then revalidates; identical fresh content
    // never resets the canvas, and a failed revalidation keeps the cached view.
    useEffect(() => {
        if (isNew || !graphId || !isDesktop) return
        let cancelled = false

        const cached = getCachedAgent(graphId)
        if (cached) {
            setAgent(cached)
            setLoadError(null)
        }

        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const found = await getAgent(token, graphId)
                if (!cancelled) {
                    if (!cached || JSON.stringify(cached) !== JSON.stringify(found)) setAgent(found)
                    setLoadError(null)
                }
            } catch (err: any) {
                if (!cancelled && !cached) setLoadError(err?.message ?? t('agentsPage.graphEditorPage.loadFailed'))
            }
        }
        load()
        return () => { cancelled = true }
    }, [graphId, isNew, isDesktop, getAccessTokenSilently, t])

    // Load instructions (instruction picker) and node presets (palette) once
    useEffect(() => {
        if (!isDesktop) return
        let cancelled = false
        const load = async () => {
            const token = await getAccessTokenSilently()
            const loadInstructions = async () => {
                try {
                    const data = await getCustomerInstructions(token)
                    if (!cancelled) setInstructions(toInstructionOptions(data.instructions ?? []))
                } catch (err) {
                    console.error('Failed to load instructions', err)
                    if (!cancelled) setInstructions([])
                }
            }
            // Non-fatal: without presets the palette's "Node types" primitives still work
            const loadPresets = async () => {
                try {
                    const data = await getNodePresets(token)
                    if (!cancelled) setPresets(data.presets ?? [])
                } catch (err) {
                    console.error('Failed to load node presets', err)
                    if (!cancelled) setPresets([])
                }
            }
            await Promise.all([loadInstructions(), loadPresets()])
        }
        load().catch(err => console.error('Failed to load editor data', err))
        return () => { cancelled = true }
    }, [isDesktop, getAccessTokenSilently])

    // Unsaved-changes guards: full page unloads + browser back navigation
    useEffect(() => {
        if (!dirty) return
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault()
            e.returnValue = ''
        }
        const handlePopState = () => {
            if (!window.confirm(t('agentsPage.graphEditorPage.unsavedChangesWarning'))) {
                window.history.forward()
            }
        }
        window.addEventListener('beforeunload', handleBeforeUnload)
        window.addEventListener('popstate', handlePopState)
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload)
            window.removeEventListener('popstate', handlePopState)
        }
    }, [dirty, t])

    // Node model preference: only vendors the customer has a valid API key
    // for are offered (the graph runs on the customer's own keys).
    const vendors = useMemo(
        () =>
            (aiVendorAPIKeyStatusList ?? [])
                .filter(s => s.status === APIKeyStatus.VALID || s.isAPIKeyValid)
                .map(s => ({
                    id: s.aiVendor,
                    label: vendorDisplayName(s.aiVendor),
                })),
        [aiVendorAPIKeyStatusList, vendorDisplayName]
    )

    const getModelsForVendor = useCallback(
        async (vendor: string): Promise<string[]> => {
            if (!customerId) return []
            const token = await getAccessTokenSilently()
            const response = await getTextGenerationModels(token, customerId, {
                aiVendor: [vendor as AIVendor],
            })
            return response.aiVendorModelList?.find(v => v.aiVendor === vendor)?.modelsList ?? []
        },
        [customerId, getAccessTokenSilently]
    )

    const graph: AgentGraph | null = useMemo(() => {
        if (!agent) return null
        return {
            graphId: agent.graphId,
            name: agent.name,
            isDefault: agent.isDefault,
            entryPoint: agent.entryPoint,
            maxIterations: agent.maxIterations,
            edges: agent.edges,
            layout: agent.layout,
            nodes: agent.nodes.map(n => ({
                nodeId: n.nodeId,
                nodeType: n.nodeType,
                name: n.name,
                config: n.config,
            })),
        }
    }, [agent])

    // Pre-made palette nodes from the API, mapped onto the library's catalog
    // shape. hasPrompt comes from the underlying primitive; an empty
    // requiredAttributes list is passed as undefined so the palette falls back
    // to the primitive's contract lines.
    const nodeCatalog: NodeCatalogEntry[] = useMemo(
        () => presets.map(preset => ({
            nodeType: preset.nodeType,
            label: preset.name,
            description: preset.description,
            defaultConfig: preset.config,
            hasPrompt: DEFAULT_NODE_TYPE_INFOS.find(i => i.nodeType === preset.nodeType)?.hasPrompt ?? false,
            requiredAttributes: preset.requiredAttributes?.length ? preset.requiredAttributes : undefined,
        })),
        [presets],
    )

    const conditionOptions: ConditionOption[] = useMemo(
        () => CONDITION_DEFS.map(def => ({ key: def.key, type: def.type, label: t(def.labelKey) })),
        [t],
    )

    const handleSave = useCallback(async (emitted: AgentGraph) => {
        setErrorMessage(null)
        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            if (!agent) {
                // /agents/new — every node still carries its temp id
                const req: CreateGraphAgentRequest = {
                    name: emitted.name,
                    maxIterations: emitted.maxIterations,
                    entryPoint: emitted.entryPoint,
                    edges: emitted.edges,
                    category: newAgentCategory,
                    ...(emitted.layout !== undefined ? { layout: emitted.layout } : {}),
                    ...(emitted.isDefault !== undefined ? { isDefault: emitted.isDefault } : {}),
                    nodes: emitted.nodes.map(n => ({
                        tempId: n.nodeId,
                        nodeType: n.nodeType,
                        name: n.name,
                        config: n.config,
                    })),
                }
                const created = await createGraphAgent(token, req)
                setDirty(false)
                setAgent(created)
                navigate(`/agents/${created.graphId}`, { replace: true })
            } else {
                // Own agents only — System agents are read-only (edits 403)
                // and are copied via the explicit Fork button instead.
                const req = buildUpdateAgentRequest(agent, emitted)
                if (Object.keys(req).length === 0) return
                const updated = await updateAgent(token, agent.graphId, req)
                setDirty(false)
                setAgent(updated)
            }
        } catch (err: any) {
            setErrorMessage(err?.message ?? t('agentsPage.graphEditorPage.saveFailed'))
        } finally {
            setSaving(false)
        }
    }, [agent, newAgentCategory, getAccessTokenSilently, navigate, t])

    // Fork the read-only System agent into an editable copy and open it
    const handleFork = useCallback(async () => {
        if (!agent) return
        setForking(true)
        setErrorMessage(null)
        try {
            const token = await getAccessTokenSilently()
            const fork = await forkAgent(token, agent.graphId)
            setAgent(fork)
            navigate(`/agents/${fork.graphId}`, { replace: true })
        } catch (err: any) {
            setErrorMessage(err?.message ?? t('agentsPage.graphEditorPage.forkFailed'))
        } finally {
            setForking(false)
        }
    }, [agent, getAccessTokenSilently, navigate, t])

    // Category changes on an existing own agent save immediately (the graph
    // save button only activates on canvas edits).
    const handleCategoryChange = useCallback(async (value: AgentCategory) => {
        if (!agent) {
            setNewAgentCategory(value)
            return
        }
        const previous = agent
        setAgent({ ...agent, category: value })
        try {
            const token = await getAccessTokenSilently()
            const updated = await updateAgent(token, agent.graphId, { category: value })
            setAgent(current => (current?.graphId === updated.graphId ? updated : current))
        } catch (err: any) {
            setAgent(previous)
            setErrorMessage(err?.message ?? t('agentsPage.graphEditorPage.saveFailed'))
        }
    }, [agent, getAccessTokenSilently, t])

    const handleDirtyChange = useCallback((value: boolean) => setDirty(value), [])

    const handleRequestCreateInstruction = useCallback(() => {
        window.open('/instructions', '_blank')
    }, [])

    // ── Small screens: notice only ────────────────────────────────────────────

    if (!isDesktop) return <DesktopNeededNotice graphId={isNew ? undefined : graphId} />

    // ── Desktop: full-height visual editor ────────────────────────────────────

    const loading = !isNew && !agent && !loadError

    return (
        <div className={styles.page}>
            <Navbar />

            {isReadOnly && (
                <div className={styles.systemBanner} role="note">
                    <span aria-hidden="true">ℹ️</span>
                    <p>{t('agentsPage.graphEditorPage.systemBanner')}</p>
                    <button
                        type="button"
                        className={styles.forkBtn}
                        onClick={handleFork}
                        disabled={forking}
                        data-testid="graph-editor-fork"
                    >
                        <Icon src={ICONS.GIT_FORK} size={14} />{' '}
                        {forking ? t('agentsPage.graphEditorPage.forking') : t('agentsPage.graphEditorPage.forkToEdit')}
                    </button>
                </div>
            )}

            {/* Category lives outside the canvas: it groups the agent on the
                Agents page and gates the conversation picker */}
            {!loading && !loadError && !isReadOnly && (
                <div className={styles.categoryBar}>
                    <label className={styles.categoryLabel} htmlFor="agent-category-select">
                        {t('agentsPage.graphEditorPage.categoryLabel')}
                    </label>
                    <select
                        id="agent-category-select"
                        className={styles.categorySelect}
                        value={agent ? agentCategory(agent) : newAgentCategory}
                        onChange={e => handleCategoryChange(e.target.value as AgentCategory)}
                        data-testid="agent-category-select"
                    >
                        {AGENT_CATEGORIES.map(c => (
                            <option key={c} value={c}>
                                {t(`agentsPage.categories.${c === 'TITLE_CREATOR' ? 'titleCreator' : c.toLowerCase()}`)}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {loading && (
                <div className={styles.stateContainer}>
                    <div className={styles.spinner} />
                    <p className={styles.stateText}>{t('agentsPage.graphEditorPage.loading')}</p>
                </div>
            )}

            {loadError && (
                <div className={styles.stateContainer}>
                    <span className={styles.stateIcon} aria-hidden="true">⚠️</span>
                    <p className={styles.stateText}>{loadError}</p>
                    <Link to="/agents" className={styles.backLink}>
                        {t('agentsPage.graphEditorPage.backToAgents')}
                    </Link>
                </div>
            )}

            {!loading && !loadError && (
                <div className={styles.editorContainer}>
                    <GraphEditor
                        graph={graph}
                        nodeCatalog={nodeCatalog}
                        instructions={instructions}
                        conditionOptions={conditionOptions}
                        vendors={vendors}
                        getModelsForVendor={getModelsForVendor}
                        readOnly={isReadOnly}
                        saving={saving}
                        errorMessage={errorMessage}
                        onSave={handleSave}
                        onDirtyChange={handleDirtyChange}
                        onRequestCreateInstruction={handleRequestCreateInstruction}
                    />
                </div>
            )}
        </div>
    )
}
