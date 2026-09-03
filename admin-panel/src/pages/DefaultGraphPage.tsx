import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AgentGraph, GraphEditor, InstructionOption } from '@genflowly/component-library'
import { DefaultGraphResponse } from '../models/defaultGraph.models'
import { getCustomerInstructions } from '../services/instructionsService'
import {
    getDefaultGraph,
    publishDefaultGraph,
    updateDefaultGraph,
} from '../services/defaultGraphService'
import {
    CONDITION_OPTIONS,
    diffGraphUpdate,
    toEditorGraph,
    toInstructionOptions,
} from '../lib/agentGraph'
import { useNodePresetCatalog } from '../lib/useNodePresetCatalog'

/**
 * The System default graph on the visual editor. Unpublished: a blank canvas
 * whose first save publishes the graph. Published: edits are diffed into a
 * partial PUT.
 */
export default function DefaultGraphPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [graph, setGraph] = useState<DefaultGraphResponse | null>(null)
    const [instructionOptions, setInstructionOptions] = useState<InstructionOption[]>([])
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const { catalog, saveNodeAsPreset, presetNotice } = useNodePresetCatalog(getAccessTokenSilently)

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            setGraph(await getDefaultGraph(token))
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load the default graph')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

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

    // Memoized: the editor re-initializes (dropping unsaved work) whenever the
    // graph prop reference changes.
    const editorGraph: AgentGraph | null = useMemo(
        () => (graph ? toEditorGraph(graph) : null),
        [graph]
    )

    const handleSave = async (edited: AgentGraph) => {
        setSaving(true)
        setSaveError(null)
        try {
            const token = await getAccessTokenSilently()
            if (graph) {
                const payload = diffGraphUpdate(graph, edited)
                if (Object.keys(payload).length > 0) {
                    setGraph(await updateDefaultGraph(token, payload))
                }
            } else {
                await publishDefaultGraph(token, {
                    name: edited.name,
                    maxIterations: edited.maxIterations,
                    entryPoint: edited.entryPoint,
                    edges: edited.edges,
                    layout: edited.layout,
                    nodes: edited.nodes.map((node) => ({
                        tempId: node.nodeId,
                        nodeType: node.nodeType,
                        name: node.name,
                        config: node.config,
                    })),
                })
                await refresh()
            }
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : 'Saving the default graph failed')
        } finally {
            setSaving(false)
        }
    }

    if (loading) return <div className="centered">Loading default graph…</div>
    if (loadError) return <div className="banner error">{loadError}</div>

    return (
        <>
            {presetNotice && (
                <div className={`row-message ${presetNotice.kind}`}>{presetNotice.text}</div>
            )}
            <div className="graph-editor-shell">
                <GraphEditor
                    graph={editorGraph}
                    nodeCatalog={catalog}
                    instructions={instructionOptions}
                    conditionOptions={CONDITION_OPTIONS}
                    saving={saving}
                    errorMessage={saveError}
                    onSave={(edited) => void handleSave(edited)}
                    onSaveAsPreset={(node) => void saveNodeAsPreset(node)}
                />
            </div>
        </>
    )
}
