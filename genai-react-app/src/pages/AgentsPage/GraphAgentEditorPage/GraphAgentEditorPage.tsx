import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GraphEditor } from '@genflowly/component-library'
import type { AgentGraph, ConditionOption, InstructionOption, NodeCatalogEntry } from '@genflowly/component-library'
import Navbar from '../../../components/navbar/Navbar'
import MobileHeader from '../../../components/widgets/MobileHeader/MobileHeader'
import EditAgentPage from '../EditAgentPage/EditAgentPage'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import { usePageTitle } from '../../../hooks/usePageTitle'
import { createGraphAgent, getAgent, updateAgent } from '../../../services/agentsService'
import { getCustomerInstructions } from '../../../services/instructionService'
import {
    Agent,
    CreateGraphAgentRequest,
    NewAgentNode,
    UpdateAgentNodePatch,
    UpdateAgentRequest,
} from '../../../models/agents.models'
import { InstructionResponse } from '../../../models/instruction.models'
import styles from './GraphAgentEditorPage.module.scss'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Editor-created nodes carry ids with this prefix until the server assigns real ones. */
const TEMP_NODE_ID_PREFIX = 'new-'

const DESKTOP_MIN_WIDTH_QUERY = '(min-width: 900px)'

const INSTRUCTION_PREVIEW_LENGTH = 200

/**
 * Node palette of the visual editor. Labels/descriptions are i18n keys under
 * agentsPage.graphEditorPage.catalog, resolved at render time.
 */
const NODE_CATALOG_DEFS: ReadonlyArray<{
    nodeType: string
    labelKey: string
    descriptionKey: string
    defaultConfig: string
    hasPrompt: boolean
    /** i18n keys of the contract lines shown on the palette item. */
    attributeKeys: string[]
}> = [
    {
        nodeType: 'QUERY_ANALYZER',
        labelKey: 'agentsPage.graphEditorPage.catalog.queryAnalyzer',
        attributeKeys: [
            'agentsPage.graphEditorPage.catalog.contractPrompt',
            'agentsPage.graphEditorPage.catalog.queryAnalyzerContractOutput',
        ],
        descriptionKey: 'agentsPage.graphEditorPage.catalog.queryAnalyzerDescription',
        defaultConfig: JSON.stringify({
            input_template: 'Query: {original_query}',
            response_format: 'json',
            json_output_mapping: { intent: 'query_intent', needs_rewrite: 'needs_rewrite' },
        }),
        hasPrompt: true,
    },
    {
        nodeType: 'QUERY_REWRITER',
        labelKey: 'agentsPage.graphEditorPage.catalog.queryRewriter',
        attributeKeys: [
            'agentsPage.graphEditorPage.catalog.contractPrompt',
            'agentsPage.graphEditorPage.catalog.queryRewriterContractOutput',
        ],
        descriptionKey: 'agentsPage.graphEditorPage.catalog.queryRewriterDescription',
        defaultConfig: JSON.stringify({
            input_template: 'Original query: {original_query}\nIntent: {query_intent}',
            output_key: 'rewritten_query',
            response_format: 'text',
        }),
        hasPrompt: true,
    },
    {
        nodeType: 'RESULT_RANKER',
        labelKey: 'agentsPage.graphEditorPage.catalog.resultRanker',
        attributeKeys: [
            'agentsPage.graphEditorPage.catalog.contractPrompt',
            'agentsPage.graphEditorPage.catalog.resultRankerContractInput',
            'agentsPage.graphEditorPage.catalog.resultRankerContractOutput',
        ],
        descriptionKey: 'agentsPage.graphEditorPage.catalog.resultRankerDescription',
        defaultConfig: JSON.stringify({
            input_template: 'Query: {query}\n\nChunks:\n{chunks_text}',
            output_key: 'ranked_results',
            response_format: 'json_indices',
            json_indices_source_key: 'retrieval_results',
        }),
        hasPrompt: true,
    },
    {
        nodeType: 'RESPONSE_GENERATOR',
        labelKey: 'agentsPage.graphEditorPage.catalog.responseGenerator',
        attributeKeys: [
            'agentsPage.graphEditorPage.catalog.responseGeneratorContractPersona',
            'agentsPage.graphEditorPage.catalog.responseGeneratorContractOutput',
            'agentsPage.graphEditorPage.catalog.responseGeneratorContractStreaming',
        ],
        descriptionKey: 'agentsPage.graphEditorPage.catalog.responseGeneratorDescription',
        defaultConfig: JSON.stringify({
            input_template: 'Context:\n{context}\n\nQuestion: {query}',
            output_key: 'generated_response',
            response_format: 'text',
            include_conversation_history: true,
            is_streaming: true,
        }),
        hasPrompt: false,
    },
]

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

// ── GraphAgentEditorPage ──────────────────────────────────────────────────────

/**
 * Full-screen visual agent editor. On desktop it renders the library's
 * GraphEditor; on small screens it falls back to the form-based EditAgentPage
 * for existing agents and shows a "needs a larger screen" notice for new ones.
 */
export default function GraphAgentEditorPage() {
    const { t } = useTranslation()
    const { graphId } = useParams<{ graphId: string }>()
    const navigate = useNavigate()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    const isDesktop = useIsDesktop()
    const isNew = !graphId || graphId === 'new'
    usePageTitle()

    const [agent, setAgent] = useState<Agent | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [instructions, setInstructions] = useState<InstructionOption[]>([])
    const [saving, setSaving] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [dirty, setDirty] = useState(false)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    // Load the agent (existing graphs only) — desktop editor path
    useEffect(() => {
        if (isNew || !graphId || !isDesktop) return
        let cancelled = false
        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const found = await getAgent(token, graphId)
                if (!cancelled) {
                    setAgent(found)
                    setLoadError(null)
                }
            } catch (err: any) {
                if (!cancelled) setLoadError(err?.message ?? t('agentsPage.graphEditorPage.loadFailed'))
            }
        }
        load()
        return () => { cancelled = true }
    }, [graphId, isNew, isDesktop, getAccessTokenSilently, t])

    // Load instructions once for the editor's instruction picker
    useEffect(() => {
        if (!isDesktop) return
        let cancelled = false
        const load = async () => {
            try {
                const token = await getAccessTokenSilently()
                const data = await getCustomerInstructions(token)
                if (!cancelled) setInstructions(toInstructionOptions(data.instructions ?? []))
            } catch (err) {
                console.error('Failed to load instructions', err)
                if (!cancelled) setInstructions([])
            }
        }
        load()
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

    const nodeCatalog: NodeCatalogEntry[] = useMemo(
        () => NODE_CATALOG_DEFS.map(def => ({
            nodeType: def.nodeType,
            label: t(def.labelKey),
            description: t(def.descriptionKey),
            defaultConfig: def.defaultConfig,
            hasPrompt: def.hasPrompt,
            requiredAttributes: def.attributeKeys.map(key => t(key)),
        })),
        [t],
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
                const req = buildUpdateAgentRequest(agent, emitted)
                if (Object.keys(req).length === 0) return
                const updated = await updateAgent(token, agent.graphId, req)
                setDirty(false)
                setAgent(updated)
                // Saving a System agent forks it server-side: the response
                // carries a new graphId — move (replace) to the private copy
                if (updated.graphId !== agent.graphId) {
                    navigate(`/agents/${updated.graphId}`, { replace: true })
                }
            }
        } catch (err: any) {
            setErrorMessage(err?.message ?? t('agentsPage.graphEditorPage.saveFailed'))
        } finally {
            setSaving(false)
        }
    }, [agent, getAccessTokenSilently, navigate, t])

    const handleDirtyChange = useCallback((value: boolean) => setDirty(value), [])

    const handleRequestCreateInstruction = useCallback(() => {
        window.open('/instructions', '_blank')
    }, [])

    // ── Mobile fallbacks ──────────────────────────────────────────────────────

    if (!isDesktop) {
        if (!isNew) return <EditAgentPage />
        return (
            <div className={styles.mobilePage}>
                <MobileHeader title={t('agentsPage.graphEditorPage.mobileCreateTitle')} />
                <div className={styles.mobileNotice}>
                    <span className={styles.mobileNoticeIcon} aria-hidden="true">🖥️</span>
                    <h1 className={styles.mobileNoticeTitle}>{t('agentsPage.graphEditorPage.mobileCreateTitle')}</h1>
                    <p className={styles.mobileNoticeBody}>{t('agentsPage.graphEditorPage.mobileCreateBody')}</p>
                    <Link to="/agents" className={styles.backLink}>
                        {t('agentsPage.graphEditorPage.backToAgents')}
                    </Link>
                </div>
            </div>
        )
    }

    // ── Desktop: full-height visual editor ────────────────────────────────────

    const loading = !isNew && !agent && !loadError

    return (
        <div className={styles.page}>
            <Navbar />

            {agent?.isSystem && (
                <div className={styles.systemBanner} role="note">
                    <span aria-hidden="true">ℹ️</span>
                    <p>{t('agentsPage.editAgentPage.systemBanner')}</p>
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
