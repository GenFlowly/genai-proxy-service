import { useCallback, useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AIVendor, VENDOR_LABELS } from '../constants/vendors'
import { REQUEST_TYPE_VARIABLES, RequestType } from '../constants/requestTypes'
import {
    AgentResponse,
    GenerationNodeConfig,
    RequestAgentMapStatus,
} from '../models/requestAgents.models'
import { InstructionResponse } from '../models/instructions.models'
import { getCustomerInstructions } from '../services/instructionsService'
import { getSystemVendorModels } from '../services/systemApiKeysService'
import { createAgent, updateAgent } from '../services/requestAgentsService'

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
export function generationNode(agent: AgentResponse) {
    const node = agent.nodes.find((n) => n.nodeId === agent.entryPoint)
    return node?.nodeType === 'GENERATION' ? node : null
}

export function parseConfig(config: string): GenerationNodeConfig | null {
    try {
        return JSON.parse(config) as GenerationNodeConfig
    } catch {
        return null
    }
}

/**
 * Create/edit form for prompt-template agents (an instruction wrapped with
 * generation settings). Pass `editingAgent` to edit an existing GENERATION
 * agent; otherwise the form creates a new one. Mapping an agent to a default
 * action happens on the Default Actions Mapping page.
 */
export default function AgentManager({
    editingAgent,
    mapEntries,
    onCancel,
    onChanged,
}: {
    editingAgent: AgentResponse | null
    /** Action registry from the map-status API — drives the variable hints. */
    mapEntries: RequestAgentMapStatus[]
    onCancel: () => void
    onChanged: () => Promise<void> | void
}) {
    const { getAccessTokenSilently } = useAuth0()

    const [instructions, setInstructions] = useState<InstructionResponse[]>([])
    const [form, setForm] = useState<CreateAgentForm>(emptyCreateForm())
    const updateForm = (patch: Partial<CreateAgentForm>) =>
        setForm((prev) => ({ ...prev, ...patch }))
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

    const loadInstructions = useCallback(async () => {
        try {
            const token = await getAccessTokenSilently()
            const response = await getCustomerInstructions(token)
            // Only instructions this account created — shared/public ones from
            // other customers are not prompt-template candidates
            const owned = response.instructions.filter(
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
        } catch {
            // The dropdown stays empty and creation is effectively disabled.
        }
    }, [getAccessTokenSilently])

    useEffect(() => {
        void loadInstructions()
    }, [loadInstructions])

    const loadModelsForVendor = useCallback(
        async (vendor: string) => {
            if (!vendor) return
            try {
                const token = await getAccessTokenSilently()
                const response = await getSystemVendorModels(token, vendor)
                setVendorModels((prev) => ({ ...prev, [vendor]: response.models }))
            } catch {
                // No system key for this vendor (or fetch failed) — the model
                // field stays free-text, which is all we need.
                setVendorModels((prev) => ({ ...prev, [vendor]: [] }))
            }
        },
        [getAccessTokenSilently]
    )

    // Sync the form with the agent the parent wants edited (or reset to
    // create mode when it clears).
    useEffect(() => {
        setCreateMessage(null)
        setCreateMessageKind(null)
        if (!editingAgent) {
            setEditing(null)
            setForm(emptyCreateForm())
            return
        }
        const node = generationNode(editingAgent)
        const config = node ? parseConfig(node.config) : null
        if (!node || !config) {
            setEditing(null)
            setForm(emptyCreateForm())
            return
        }
        setEditing({
            graphId: editingAgent.graphId,
            nodeId: node.nodeId,
            instructionVersion: config.instruction_version ?? null,
            maxTokens: config.max_tokens ?? null,
        })
        setForm({
            name: editingAgent.name,
            instructionId: config.instruction_id,
            outputFormat: config.output_format === 'json' ? 'json' : 'text',
            vendor: config.model_preference?.vendor ?? '',
            model: config.model_preference?.model ?? '',
            inputTemplate: config.input_template ?? '',
        })
        if (config.model_preference?.vendor) void loadModelsForVendor(config.model_preference.vendor)
    }, [editingAgent, loadModelsForVendor])

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
                setCreateMessage(
                    `Agent created: ${created.graphId} — map it on the Default Actions Mapping page`
                )
            }
            setCreateMessageKind('success')
            await onChanged()
        } catch (e) {
            setCreateMessage(e instanceof Error ? e.message : 'Failed to save agent')
            setCreateMessageKind('error')
        } finally {
            setCreating(false)
        }
    }

    return (
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
                            if (!vendorModels[e.target.value]) void loadModelsForVendor(e.target.value)
                        }}
                    >
                        <option value="">Platform default (persona: system failover)</option>
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
                Available template variables (system prompt + input template) by action:
                {mapEntries.length > 0
                    ? mapEntries.map((entry) => (
                          <div key={entry.requestType}>
                              <strong>{entry.displayName ?? entry.requestType}</strong>:{' '}
                              {(
                                  entry.templateVariables ??
                                  REQUEST_TYPE_VARIABLES[entry.requestType as RequestType] ??
                                  []
                              ).join(', ')}
                          </div>
                      ))
                    : Object.values(RequestType).map((rt) => (
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
                <button disabled={creating} onClick={onCancel}>
                    Cancel
                </button>
            </div>
            {createMessage && (
                <div className={`row-message ${createMessageKind ?? ''}`}>{createMessage}</div>
            )}
        </div>
    )
}
