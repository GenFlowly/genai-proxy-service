import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { NodePresetResponse } from '../models/nodePresets.models'
import {
    createNodePreset,
    deleteNodePreset,
    getNodePresets,
    updateNodePreset,
} from '../services/nodePresetsService'

type EditRowState = {
    expanded: boolean
    name: string
    description: string
    sortOrder: string
    config: string
    /** One required-attribute contract line per row. */
    requiredAttributes: string
    busy: boolean
    message: string | null
    messageKind: 'success' | 'error' | null
}

const emptyEditRow = (): EditRowState => ({
    expanded: false,
    name: '',
    description: '',
    sortOrder: '0',
    config: '{}',
    requiredAttributes: '',
    busy: false,
    message: null,
    messageKind: null,
})

const editRowFromPreset = (preset: NodePresetResponse): EditRowState => ({
    ...emptyEditRow(),
    expanded: true,
    name: preset.name,
    description: preset.description,
    sortOrder: String(preset.sortOrder),
    config: preset.config,
    requiredAttributes: preset.requiredAttributes.join('\n'),
})

type CreateForm = {
    name: string
    nodeType: string
    description: string
    config: string
}

const emptyCreateForm = (): CreateForm => ({ name: '', nodeType: '', description: '', config: '' })

function parseAttributes(raw: string): string[] {
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

/** Client-side guard mirroring the backend's config validation: must be JSON. */
function configError(raw: string): string | null {
    try {
        JSON.parse(raw)
        return null
    } catch {
        return 'Config must be valid JSON'
    }
}

/**
 * Manages the DDB-backed pre-made nodes offered in the graph editor palette:
 * each preset as a card with inline edit and delete, plus a create form.
 */
export default function NodePresetsPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [presets, setPresets] = useState<NodePresetResponse[]>([])

    const [rows, setRows] = useState<Record<string, EditRowState>>({})
    const updateRow = (presetId: string, patch: Partial<EditRowState>) =>
        setRows((prev) => ({ ...prev, [presetId]: { ...(prev[presetId] ?? emptyEditRow()), ...patch } }))

    const [form, setForm] = useState<CreateForm>(emptyCreateForm())
    const updateForm = (patch: Partial<CreateForm>) => setForm((prev) => ({ ...prev, ...patch }))
    const [creating, setCreating] = useState(false)
    const [createMessage, setCreateMessage] = useState<string | null>(null)
    const [createMessageKind, setCreateMessageKind] = useState<'success' | 'error' | null>(null)

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await getNodePresets(token)
            setPresets(response.presets)
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load node presets')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const handleSave = async (preset: NodePresetResponse) => {
        const row = rows[preset.presetId]
        if (!row) return
        if (!row.name.trim()) {
            updateRow(preset.presetId, { message: 'Name is required', messageKind: 'error' })
            return
        }
        const jsonError = configError(row.config)
        if (jsonError) {
            updateRow(preset.presetId, { message: jsonError, messageKind: 'error' })
            return
        }
        updateRow(preset.presetId, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await updateNodePreset(token, preset.presetId, {
                name: row.name.trim(),
                nodeType: preset.nodeType,
                description: row.description.trim(),
                config: row.config,
                requiredAttributes: parseAttributes(row.requiredAttributes),
                sortOrder: Number(row.sortOrder) || 0,
            })
            updateRow(preset.presetId, {
                busy: false,
                expanded: false,
                message: 'Preset saved — palettes pick it up on next load',
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateRow(preset.presetId, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to save preset',
                messageKind: 'error',
            })
        }
    }

    const handleDelete = async (preset: NodePresetResponse) => {
        if (!window.confirm(`Delete preset "${preset.name}"? It disappears from the editor palette.`)) {
            return
        }
        updateRow(preset.presetId, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await deleteNodePreset(token, preset.presetId)
            await refresh()
        } catch (e) {
            updateRow(preset.presetId, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to delete preset',
                messageKind: 'error',
            })
        }
    }

    const handleCreate = async () => {
        if (!form.name.trim() || !form.nodeType.trim()) return
        const config = form.config.trim() || '{}'
        const jsonError = configError(config)
        if (jsonError) {
            setCreateMessage(jsonError)
            setCreateMessageKind('error')
            return
        }
        setCreating(true)
        setCreateMessage(null)
        setCreateMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            const created = await createNodePreset(token, {
                name: form.name.trim(),
                nodeType: form.nodeType.trim(),
                description: form.description.trim(),
                config,
                requiredAttributes: [],
                sortOrder: 0,
            })
            setForm(emptyCreateForm())
            setCreateMessage(`Preset "${created.name}" created`)
            setCreateMessageKind('success')
            await refresh()
        } catch (e) {
            setCreateMessage(e instanceof Error ? e.message : 'Failed to create preset')
            setCreateMessageKind('error')
        } finally {
            setCreating(false)
        }
    }

    if (loading) return <div className="centered">Loading node presets…</div>

    return (
        <section className="page">
            <h2>Node Presets</h2>
            <p className="page-description">
                The pre-made nodes offered in the graph editor palette (default graph and agent
                editors). Each preset wraps a runtime node type with a name, description and a
                default config; sort order controls its position in the palette.
            </p>

            {loadError && <div className="banner error">{loadError}</div>}

            <div className="vendor-list">
                {presets.map((preset) => {
                    const row = rows[preset.presetId] ?? emptyEditRow()
                    return (
                        <div className="vendor-card" key={preset.presetId}>
                            <div className="vendor-card-header">
                                <h3>{preset.name}</h3>
                                <div className="header-pills">
                                    <span className="status-pill priority">{preset.nodeType}</span>
                                    <span className="status-pill">Order {preset.sortOrder}</span>
                                </div>
                            </div>

                            {preset.description && (
                                <p className="page-description">{preset.description}</p>
                            )}
                            {preset.requiredAttributes.length > 0 && (
                                <ul className="bootstrap-steps">
                                    {preset.requiredAttributes.map((line) => (
                                        <li key={line} className="map-details">
                                            • {line}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="vendor-card-body">
                                <button
                                    disabled={row.busy}
                                    onClick={() =>
                                        setRows((prev) => ({
                                            ...prev,
                                            [preset.presetId]: row.expanded
                                                ? { ...row, expanded: false }
                                                : editRowFromPreset(preset),
                                        }))
                                    }
                                >
                                    {row.expanded ? 'Cancel' : 'Edit'}
                                </button>
                                <button
                                    className="danger"
                                    disabled={row.busy}
                                    onClick={() => void handleDelete(preset)}
                                >
                                    Delete
                                </button>
                            </div>

                            {row.expanded && (
                                <div className="node-config">
                                    <div className="config-row">
                                        <label className="config-field grow">
                                            Name
                                            <input
                                                type="text"
                                                value={row.name}
                                                disabled={row.busy}
                                                onChange={(e) =>
                                                    updateRow(preset.presetId, { name: e.target.value })
                                                }
                                            />
                                        </label>
                                        <label className="config-field">
                                            Sort order
                                            <input
                                                type="number"
                                                value={row.sortOrder}
                                                disabled={row.busy}
                                                onChange={(e) =>
                                                    updateRow(preset.presetId, {
                                                        sortOrder: e.target.value,
                                                    })
                                                }
                                            />
                                        </label>
                                    </div>
                                    <div className="config-row">
                                        <label className="config-field grow">
                                            Description
                                            <input
                                                type="text"
                                                value={row.description}
                                                disabled={row.busy}
                                                onChange={(e) =>
                                                    updateRow(preset.presetId, {
                                                        description: e.target.value,
                                                    })
                                                }
                                            />
                                        </label>
                                    </div>
                                    <label className="config-field grow">
                                        Config (JSON)
                                        <textarea
                                            rows={6}
                                            value={row.config}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateRow(preset.presetId, { config: e.target.value })
                                            }
                                        />
                                    </label>
                                    {configError(row.config) && (
                                        <div className="row-message error">{configError(row.config)}</div>
                                    )}
                                    <label className="config-field grow">
                                        Contract lines (one per line, shown in the palette)
                                        <textarea
                                            rows={4}
                                            value={row.requiredAttributes}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateRow(preset.presetId, {
                                                    requiredAttributes: e.target.value,
                                                })
                                            }
                                        />
                                    </label>
                                    <div className="form-actions">
                                        <button
                                            className="primary"
                                            disabled={
                                                row.busy ||
                                                !row.name.trim() ||
                                                configError(row.config) !== null
                                            }
                                            onClick={() => void handleSave(preset)}
                                        >
                                            {row.busy ? 'Saving…' : 'Save preset'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {row.message && (
                                <div className={`row-message ${row.messageKind ?? ''}`}>
                                    {row.message}
                                </div>
                            )}
                        </div>
                    )
                })}
                {presets.length === 0 && (
                    <p className="page-description">
                        No presets yet — create one below, or use “Save as pre-made node” on a
                        node in the graph editor.
                    </p>
                )}
            </div>

            <div className="form-card">
                <h4>New preset</h4>
                <label>
                    Name
                    <input
                        type="text"
                        placeholder="e.g. Query Rewriter"
                        value={form.name}
                        disabled={creating}
                        onChange={(e) => updateForm({ name: e.target.value })}
                    />
                </label>
                <label>
                    Node type
                    <input
                        type="text"
                        placeholder="e.g. QUERY_REWRITER"
                        value={form.nodeType}
                        disabled={creating}
                        onChange={(e) => updateForm({ nodeType: e.target.value })}
                    />
                </label>
                <label>
                    Description <span className="optional">(optional)</span>
                    <input
                        type="text"
                        placeholder="Shown under the preset in the palette"
                        value={form.description}
                        disabled={creating}
                        onChange={(e) => updateForm({ description: e.target.value })}
                    />
                </label>
                <label>
                    Config JSON <span className="optional">(optional — defaults to {'{}'})</span>
                    <textarea
                        rows={5}
                        placeholder='e.g. {"output_key": "rewritten_query"}'
                        value={form.config}
                        disabled={creating}
                        onChange={(e) => updateForm({ config: e.target.value })}
                    />
                </label>
                <div className="form-actions">
                    <button
                        className="primary"
                        disabled={creating || !form.name.trim() || !form.nodeType.trim()}
                        onClick={() => void handleCreate()}
                    >
                        {creating ? 'Creating…' : 'Create preset'}
                    </button>
                </div>
                {createMessage && (
                    <div className={`row-message ${createMessageKind ?? ''}`}>{createMessage}</div>
                )}
            </div>
        </section>
    )
}
