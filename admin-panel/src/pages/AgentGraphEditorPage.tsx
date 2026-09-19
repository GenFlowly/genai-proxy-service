import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth0 } from '@auth0/auth0-react'
import { AgentGraph, GraphEditor, InstructionOption } from '@genflowly/component-library'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import { getCustomerInstructions } from '../services/instructionsService'
import { getAgentGraph, updateAgentGraph } from '../services/defaultGraphService'
import {
    CONDITION_OPTIONS,
    diffGraphUpdate,
    toEditorGraph,
    toInstructionOptions,
    makeGraphVendors,
    makeGetModelsForVendor,
} from '../lib/agentGraph'
import { useNodePresetCatalog } from '../lib/useNodePresetCatalog'
import { useVendorDisplayNames } from '../lib/vendorNames'

/** Visual editor for one admin-owned agent graph (request agents etc.). */
export default function AgentGraphEditorPage() {
    const { graphId } = useParams<{ graphId: string }>()
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [graph, setGraph] = useState<DefaultGraphResponse | null>(null)
    const [instructionOptions, setInstructionOptions] = useState<InstructionOption[]>([])
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const { catalog, saveNodeAsPreset, presetNotice } = useNodePresetCatalog(getAccessTokenSilently)
    const getModelsForVendor = useMemo(
        () => makeGetModelsForVendor(getAccessTokenSilently),
        [getAccessTokenSilently]
    )
    const vendorDisplayName = useVendorDisplayNames()
    const graphVendors = useMemo(() => makeGraphVendors(vendorDisplayName), [vendorDisplayName])

    const refresh = useCallback(async () => {
        if (!graphId) return
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            setGraph(await getAgentGraph(token, graphId))
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : `Failed to load agent ${graphId}`)
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently, graphId])

    useEffect(() => {
        void refresh()
    }, [refresh])

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getCustomerInstructions(token)
                if (!cancelled) setInstructionOptions(toInstructionOptions(response.instructions))
            } catch {
                // Non-fatal: the editor simply shows an empty instruction list.
            }
        })()
        return () => {
            cancelled = true
        }
    }, [getAccessTokenSilently])

    const editorGraph: AgentGraph | null = useMemo(
        () => (graph ? toEditorGraph(graph) : null),
        [graph]
    )

    const handleSave = async (edited: AgentGraph) => {
        if (!graph || !graphId) return
        const payload = diffGraphUpdate(graph, edited)
        if (Object.keys(payload).length === 0) return
        setSaving(true)
        setSaveError(null)
        try {
            const token = await getAccessTokenSilently()
            setGraph(await updateAgentGraph(token, graphId, payload))
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : 'Saving the agent failed')
        } finally {
            setSaving(false)
        }
    }

    if (loading) return <div className="centered">Loading agent…</div>
    if (loadError) return <div className="banner error">{loadError}</div>
    if (!editorGraph) return null

    return (
        <>
            <div className="editor-topbar">
                <Link to="/default-agents" className="back-link">
                    ← All agents
                </Link>
            </div>
            {presetNotice && (
                <div className={`row-message ${presetNotice.kind}`}>{presetNotice.text}</div>
            )}
            <div className="graph-editor-shell">
                <GraphEditor
                    graph={editorGraph}
                    nodeCatalog={catalog}
                    instructions={instructionOptions}
                    conditionOptions={CONDITION_OPTIONS}
                    vendors={graphVendors}
                    getModelsForVendor={getModelsForVendor}
                    saving={saving}
                    errorMessage={saveError}
                    onSave={(edited) => void handleSave(edited)}
                    onSaveAsPreset={(node) => void saveNodeAsPreset(node)}
                />
            </div>
        </>
    )
}
