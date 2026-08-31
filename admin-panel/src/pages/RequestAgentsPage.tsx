import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AIVendor, VENDOR_LABELS } from '../constants/vendors'
import {
    REQUEST_TYPE_LABELS,
    REQUEST_TYPE_VARIABLES,
    RequestType,
} from '../constants/requestTypes'
import {
    AgentResponse,
    GenerationNodeConfig,
    RequestAgentMapStatus,
} from '../models/requestAgents.models'
import { InstructionResponse } from '../models/instructions.models'
import { getCustomerInstructions } from '../services/instructionsService'
import { getSystemVendorModels } from '../services/systemApiKeysService'
import {
    createAgent,
    deleteAgent,
    deleteRequestAgentMapEntry,
    getAgents,
    getRequestAgentMap,
    putRequestAgentMapEntry,
    updateAgent,
} from '../services/requestAgentsService'

type MapRowState = {
    expanded: boolean
    mapKey: string
    graphId: string
    enabled: boolean
    busy: boolean
    message: string | null
    messageKind: 'success' | 'error' | null
}

const emptyMapRow = (): MapRowState => ({
    expanded: false,
    mapKey: '',
    graphId: '',
    enabled: true,
    busy: false,
    message: null,
    messageKind: null,
})

type CreateAgentForm = {
    name: string
    instructionId: string
    outputFormat: 'text' | 'json'
    vendor: string // '' = no preference (system failover picks the model)
    model: string
    inputTemplate: string
}

const emptyCreateForm = (): CreateAgentForm => ({
    name: '',
    instructionId: '',
    outputFormat: 'text',
    vendor: '',
    model: '',
    inputTemplate: '',
})

/** The entry node of a GENERATION agent, or null for other graph shapes (e.g. the RAG default graph). */
function generationNode(agent: AgentResponse) {
    const node = agent.nodes.find((n) => n.nodeId === agent.entryPoint)
    return node?.nodeType === 'GENERATION' ? node : null
}

function parseConfig(config: string): GenerationNodeConfig | null {
    try {
        return JSON.parse(config) as GenerationNodeConfig
    } catch {
        return null
    }
}

export default function RequestAgentsPage() {
    const { getAccessTokenSilently } = useAuth0()

    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [mapEntries, setMapEntries] = useState<RequestAgentMapStatus[]>([])
    const [agents, setAgents] = useState<AgentResponse[]>([])
    const [instructions, setInstructions] = useState<InstructionResponse[]>([])

    const [mapRows, setMapRows] = useState<Record<string, MapRowState>>(() =>
        Object.fromEntries(Object.values(RequestType).map((rt) => [rt, emptyMapRow()]))
    )
    const updateMapRow = (rt: string, patch: Partial<MapRowState>) =>
        setMapRows((prev) => ({ ...prev, [rt]: { ...prev[rt], ...patch } }))

    const [form, setForm] = useState<CreateAgentForm>(emptyCreateForm())
    const updateForm = (patch: Partial<CreateAgentForm>) =>
        setForm((prev) => ({ ...prev, ...patch }))
    // When set, the form saves changes to this agent instead of creating one.
    // instructionVersion/maxTokens have no form fields — carry the original
    // values through an edit instead of silently dropping them.
    const [editing, setEditing] = useState<{
        graphId: string
        nodeId: string
        instructionVersion: number | null
        maxTokens: number | null
    } | null>(null)
    const [creating, setCreating] = useState(false)
    const [createMessage, setCreateMessage] = useState<string | null>(null)
    const [createMessageKind, setCreateMessageKind] = useState<'success' | 'error' | null>(null)
    const [vendorModels, setVendorModels] = useState<Record<string, string[]>>({})

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const [map, agentsResponse, instructionsResponse] = await Promise.all([
                getRequestAgentMap(token),
                getAgents(token),
                getCustomerInstructions(token),
            ])
            setMapEntries(map.entries)
            setAgents(agentsResponse.agents.filter((a) => generationNode(a) !== null))

            // Only instructions this account created — shared/public ones from
            // other customers are not prompt-template candidates
            const owned = instructionsResponse.instructions.filter(
                (instruction) => instruction.role === 'OWNER'
            )
            // Latest version per instruction id
            const latestById = new Map<string, InstructionResponse>()
            for (const instruction of owned) {
                const existing = latestById.get(instruction.id)
                if (!existing || instruction.version > existing.version) {
                    latestById.set(instruction.id, instruction)
                }
            }
            setInstructions(
                [...latestById.values()].sort((a, b) => a.name.localeCompare(b.name))
            )
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load request-agent data')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const loadModelsForVendor = async (vendor: string) => {
        if (!vendor || vendorModels[vendor]) return
        try {
            const token = await getAccessTokenSilently()
            const response = await getSystemVendorModels(token, vendor)
            setVendorModels((prev) => ({ ...prev, [vendor]: response.models }))
        } catch {
            // No system key for this vendor (or fetch failed) — the model
            // field stays free-text, which is all we need.
            setVendorModels((prev) => ({ ...prev, [vendor]: [] }))
        }
    }

    const handleSaveMapping = async (rt: string) => {
        const row = mapRows[rt]
        if (!row.mapKey.trim() || !row.graphId) {
            updateMapRow(rt, { message: 'Pick an agent and a map key first', messageKind: 'error' })
            return
        }
        updateMapRow(rt, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await putRequestAgentMapEntry(token, rt, {
                mapKey: row.mapKey.trim(),
                graphId: row.graphId,
                enabled: row.enabled,
            })
            updateMapRow(rt, {
                busy: false,
                expanded: false,
                message: 'Mapping saved — takes effect within ~1 minute on all instances',
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateMapRow(rt, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to save mapping',
                messageKind: 'error',
            })
        }
    }

    const handleRemoveMapping = async (rt: string) => {
        if (!window.confirm(`Remove the ${rt} mapping and revert to the bundled default?`)) return
        updateMapRow(rt, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await deleteRequestAgentMapEntry(token, rt)
            updateMapRow(rt, {
                busy: false,
                message: 'Mapping removed — bundled default is back in effect',
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateMapRow(rt, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to remove mapping',
                messageKind: 'error',
            })
        }
    }

    const startEditAgent = (agent: AgentResponse) => {
        const node = generationNode(agent)
        const config = node ? parseConfig(node.config) : null
        if (!node || !config) return
        setEditing({
            graphId: agent.graphId,
            nodeId: node.nodeId,
            instructionVersion: config.instruction_version ?? null,
            maxTokens: config.max_tokens ?? null,
        })
        setForm({
            name: agent.name,
            instructionId: config.instruction_id,
            outputFormat: config.output_format === 'json' ? 'json' : 'text',
            vendor: config.model_preference?.vendor ?? '',
            model: config.model_preference?.model ?? '',
            inputTemplate: config.input_template ?? '',
        })
        setCreateMessage(null)
        setCreateMessageKind(null)
        if (config.model_preference?.vendor) void loadModelsForVendor(config.model_preference.vendor)
    }

    const cancelEdit = () => {
        setEditing(null)
        setForm(emptyCreateForm())
        setCreateMessage(null)
        setCreateMessageKind(null)
    }

    const handleDeleteAgent = async (agent: AgentResponse) => {
        const mappedTo = mapEntries
            .filter((entry) => entry.ddbEntry?.graphId === agent.graphId)
            .map((entry) => entry.requestType)
        const warning = mappedTo.length
            ? `\n\nWARNING: it is currently mapped to ${mappedTo.join(', ')} — those will fall back to the bundled defaults.`
            : ''
        if (!window.confirm(`Delete agent "${agent.name}" (${agent.graphId})?${warning}`)) return
        setCreateMessage(null)
        setCreateMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteAgent(token, agent.graphId)
            if (editing?.graphId === agent.graphId) cancelEdit()
            setCreateMessage(`Agent ${agent.graphId} deleted`)
            setCreateMessageKind('success')
            await refresh()
        } catch (e) {
            setCreateMessage(e instanceof Error ? e.message : 'Failed to delete agent')
            setCreateMessageKind('error')
        }
    }

    /** GENERATION node config JSON for the current form (snake_case wire shape). */
    const composeNodeConfig = (): string => {
        const config: GenerationNodeConfig = {
            instruction_id: form.instructionId,
            input_template: form.inputTemplate,
            output_format: form.outputFormat,
        }
        if (editing?.instructionVersion != null) config.instruction_version = editing.instructionVersion
        if (editing?.maxTokens != null) config.max_tokens = editing.maxTokens
        if (form.vendor) config.model_preference = { vendor: form.vendor, model: form.model.trim() }
        return JSON.stringify(config)
    }

    const handleSubmitAgent = async () => {
        if (!form.name.trim() || !form.instructionId) return
        if (form.vendor && !form.model.trim()) {
            setCreateMessage('Pick a model for the selected vendor (or clear the vendor)')
            setCreateMessageKind('error')
            return
        }
        setCreating(true)
        setCreateMessage(null)
        setCreateMessageKind(null)
        try {
            const token = await getAccessTokenSilently()
            if (editing) {
                await updateAgent(token, editing.graphId, {
                    name: form.name.trim(),
                    nodes: [
                        {
                            nodeId: editing.nodeId,
                            name: form.name.trim(),
                            config: composeNodeConfig(),
                        },
                    ],
                })
                setCreateMessage(
                    `Agent ${editing.graphId} updated — mapped request types pick it up within ~1 minute`
                )
                setEditing(null)
            } else {
                const created = await createAgent(token, {
                    name: form.name.trim(),
                    instructionId: form.instructionId,
                    outputFormat: form.outputFormat,
                    modelPreference: form.vendor
                        ? { aiVendor: form.vendor, model: form.model.trim() }
                        : null,
                    inputTemplate: form.inputTemplate,
                })
                setCreateMessage(`Agent created: ${created.graphId} — pick it in a mapping above`)
            }
            setForm(emptyCreateForm())
            setCreateMessageKind('success')
            await refresh()
        } catch (e) {
            setCreateMessage(e instanceof Error ? e.message : 'Failed to save agent')
            setCreateMessageKind('error')
        } finally {
            setCreating(false)
        }
    }

    if (loading) return <div className="centered">Loading request-agent map…</div>

    return (
        <section className="page">
            <h2>Request Agents</h2>
            <p className="page-description">
                Maps each internal generation request to the agent serving it. Requests without a
                mapping use the prompts bundled with the server (source CONFIG). Prompt templates
                are regular instructions — create them on the Instructions page, wrap one in an
                agent below, then map it.
            </p>

            {loadError && <div className="banner error">{loadError}</div>}

            <div className="vendor-list">
                {mapEntries.map((entry) => {
                    const rt = entry.requestType
                    const row = mapRows[rt] ?? emptyMapRow()
                    const mapped = entry.effectiveSource === 'DDB'
                    return (
                        <div className="vendor-card" key={rt}>
                            <div className="vendor-card-header">
                                <h3>{REQUEST_TYPE_LABELS[rt as RequestType] ?? rt}</h3>
                                <div className="header-pills">
                                    <span className={`status-pill ${mapped ? 'ok' : 'unset'}`}>
                                        {mapped ? 'Mapped (DDB)' : 'Bundled default'}
                                    </span>
                                </div>
                            </div>

                            <div className="map-summary">
                                <span className="map-key">{entry.effectiveMapKey}</span>
                                {entry.ddbEntry && (
                                    <span className="map-details">
                                        → {entry.ddbEntry.graphId}
                                        {!entry.ddbEntry.enabled && ' (disabled)'}
                                        {entry.ddbEntry.updatedBy &&
                                            ` · by ${entry.ddbEntry.updatedBy}`}
                                    </span>
                                )}
                            </div>

                            <div className="vendor-card-body">
                                <button
                                    disabled={row.busy}
                                    onClick={() =>
                                        updateMapRow(rt, {
                                            expanded: !row.expanded,
                                            mapKey: row.mapKey || entry.ddbEntry?.mapKey || '',
                                            graphId: row.graphId || entry.ddbEntry?.graphId || '',
                                            enabled: entry.ddbEntry?.enabled ?? true,
                                        })
                                    }
                                >
                                    {row.expanded ? 'Cancel' : mapped ? 'Remap…' : 'Map agent…'}
                                </button>
                                {entry.ddbEntry && (
                                    <button
                                        className="danger"
                                        disabled={row.busy}
                                        onClick={() => void handleRemoveMapping(rt)}
                                    >
                                        Remove mapping
                                    </button>
                                )}
                            </div>

                            {row.expanded && (
                                <div className="config-row">
                                    <label className="config-field grow">
                                        Agent
                                        <select
                                            value={row.graphId}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { graphId: e.target.value })
                                            }
                                        >
                                            <option value="">Select an agent…</option>
                                            {agents.map((agent) => (
                                                <option key={agent.graphId} value={agent.graphId}>
                                                    {agent.name} ({agent.graphId})
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="config-field grow">
                                        Map key
                                        <input
                                            type="text"
                                            placeholder="e.g. InstructionRequestCustom"
                                            value={row.mapKey}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { mapKey: e.target.value })
                                            }
                                        />
                                    </label>
                                    <label className="config-field checkbox">
                                        <input
                                            type="checkbox"
                                            checked={row.enabled}
                                            disabled={row.busy}
                                            onChange={(e) =>
                                                updateMapRow(rt, { enabled: e.target.checked })
                                            }
                                        />
                                        Enabled
                                    </label>
                                    <button
                                        className="primary"
                                        disabled={row.busy || !row.graphId || !row.mapKey.trim()}
                                        onClick={() => void handleSaveMapping(rt)}
                                    >
                                        {row.busy ? 'Saving…' : 'Save mapping'}
                                    </button>
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
            </div>

            <h3 className="section-heading">Agents</h3>
            <p className="page-description">
                An agent wraps a prompt-template instruction with generation settings. Agents
                follow their instruction's latest version, so editing the instruction updates the
                agent automatically.
            </p>

            {agents.length > 0 && (
                <div className="created-list">
                    {agents.map((agent) => {
                        const config = parseConfig(generationNode(agent)?.config ?? '')
                        const instruction = instructions.find(
                            (i) => i.id === config?.instruction_id
                        )
                        return (
                            <div className="created-item" key={agent.graphId}>
                                <span>
                                    <strong>{agent.name}</strong> ({agent.graphId})
                                    {config && (
                                        <span className="map-details">
                                            {' '}
                                            → {instruction?.name ?? config.instruction_id}
                                            {config.instruction_version != null
                                                ? ` v${config.instruction_version}`
                                                : ' (latest)'}
                                            {' · '}
                                            {config.output_format ?? 'text'}
                                            {config.model_preference &&
                                                ` · ${config.model_preference.vendor}/${config.model_preference.model}`}
                                        </span>
                                    )}
                                </span>
                                <span className="item-actions">
                                    <button
                                        disabled={creating}
                                        onClick={() => startEditAgent(agent)}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        className="danger"
                                        disabled={creating}
                                        onClick={() => void handleDeleteAgent(agent)}
                                    >
                                        Delete
                                    </button>
                                </span>
                            </div>
                        )
                    })}
                </div>
            )}

            <div className="form-card">
                <h4>{editing ? `Edit agent ${editing.graphId}` : 'New agent'}</h4>
                <label>
                    Name
                    <input
                        type="text"
                        placeholder="e.g. Persona Generator v2"
                        value={form.name}
                        disabled={creating}
                        onChange={(e) => updateForm({ name: e.target.value })}
                    />
                </label>
                <label>
                    Prompt instruction (system prompt template)
                    <select
                        value={form.instructionId}
                        disabled={creating}
                        onChange={(e) => updateForm({ instructionId: e.target.value })}
                    >
                        <option value="">Select an instruction…</option>
                        {instructions.map((instruction) => (
                            <option key={instruction.id} value={instruction.id}>
                                {instruction.name} ({instruction.id}, v{instruction.version})
                            </option>
                        ))}
                    </select>
                </label>
                <div className="config-row">
                    <label className="config-field">
                        Output format
                        <select
                            value={form.outputFormat}
                            disabled={creating}
                            onChange={(e) =>
                                updateForm({ outputFormat: e.target.value as 'text' | 'json' })
                            }
                        >
                            <option value="text">Text</option>
                            <option value="json">JSON</option>
                        </select>
                    </label>
                    <label className="config-field">
                        Model preference
                        <select
                            value={form.vendor}
                            disabled={creating}
                            onChange={(e) => {
                                updateForm({ vendor: e.target.value, model: '' })
                                void loadModelsForVendor(e.target.value)
                            }}
                        >
                            <option value="">None (system failover decides)</option>
                            {Object.values(AIVendor).map((vendor) => (
                                <option key={vendor} value={vendor}>
                                    {VENDOR_LABELS[vendor]}
                                </option>
                            ))}
                        </select>
                    </label>
                    {form.vendor && (
                        <label className="config-field grow">
                            Model
                            <input
                                type="text"
                                list="request-agent-model-options"
                                placeholder="e.g. gpt-5"
                                value={form.model}
                                disabled={creating}
                                onChange={(e) => updateForm({ model: e.target.value })}
                            />
                            <datalist id="request-agent-model-options">
                                {(vendorModels[form.vendor] ?? []).map((model) => (
                                    <option key={model} value={model} />
                                ))}
                            </datalist>
                        </label>
                    )}
                </div>
                <label>
                    Input template (user message)
                    <input
                        type="text"
                        placeholder="e.g. {{instructionText}}"
                        value={form.inputTemplate}
                        disabled={creating}
                        onChange={(e) => updateForm({ inputTemplate: e.target.value })}
                    />
                </label>
                <div className="placeholder-hints">
                    Available template variables (system prompt + input template) by request type:
                    {Object.values(RequestType).map((rt) => (
                        <div key={rt}>
                            <strong>{rt}</strong>: {REQUEST_TYPE_VARIABLES[rt].join(', ')}
                        </div>
                    ))}
                </div>
                <div className="form-actions">
                    <button
                        className="primary"
                        disabled={creating || !form.name.trim() || !form.instructionId}
                        onClick={() => void handleSubmitAgent()}
                    >
                        {creating ? 'Saving…' : editing ? 'Save changes' : 'Create agent'}
                    </button>
                    {editing && (
                        <button disabled={creating} onClick={cancelEdit}>
                            Cancel
                        </button>
                    )}
                </div>
                {createMessage && (
                    <div className={`row-message ${createMessageKind ?? ''}`}>{createMessage}</div>
                )}
            </div>
        </section>
    )
}
