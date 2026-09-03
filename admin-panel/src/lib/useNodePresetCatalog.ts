import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentGraphNode, NodeCatalogEntry } from '@genflowly/component-library'
import { NodePresetResponse } from '../models/nodePresets.models'
import { createNodePreset, getNodePresets } from '../services/nodePresetsService'
import { toCatalogEntries } from './agentGraph'

export interface PresetNotice {
    kind: 'success' | 'error'
    text: string
}

/**
 * The pre-made node palette shared by both graph-editor pages: fetches the
 * DDB-backed presets once (fetch failure → empty palette, non-fatal) and wires
 * the editor's "Save as pre-made node" action, refreshing the palette after a
 * successful save.
 */
export function useNodePresetCatalog(getToken: () => Promise<string>): {
    catalog: NodeCatalogEntry[]
    saveNodeAsPreset: (node: AgentGraphNode) => Promise<void>
    presetNotice: PresetNotice | null
} {
    const [presets, setPresets] = useState<NodePresetResponse[]>([])
    const [presetNotice, setPresetNotice] = useState<PresetNotice | null>(null)

    const refresh = useCallback(async () => {
        try {
            const token = await getToken()
            const response = await getNodePresets(token)
            setPresets(response.presets)
        } catch {
            // Non-fatal: the palette simply shows no pre-made nodes.
        }
    }, [getToken])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const catalog = useMemo(() => toCatalogEntries(presets), [presets])

    const saveNodeAsPreset = useCallback(
        async (node: AgentGraphNode) => {
            setPresetNotice(null)
            try {
                const token = await getToken()
                const created = await createNodePreset(token, {
                    name: node.name,
                    nodeType: node.nodeType,
                    description: '',
                    config: node.config,
                    requiredAttributes: [],
                    sortOrder: 0,
                })
                setPresetNotice({
                    kind: 'success',
                    text: `Saved "${created.name}" as a pre-made node — it is now in the palette. Edit details on the Node Presets page.`,
                })
                await refresh()
            } catch (e) {
                setPresetNotice({
                    kind: 'error',
                    text: e instanceof Error ? e.message : 'Saving the pre-made node failed',
                })
            }
        },
        [getToken, refresh]
    )

    return { catalog, saveNodeAsPreset, presetNotice }
}
