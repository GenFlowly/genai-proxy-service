import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AIVendor, VENDOR_LABELS } from '../constants/vendors'
import { AIVendorAPIKeyStatus } from '../models/systemApiKeys.models'
import {
    deleteSystemApiKey,
    getSystemApiKeyStatuses,
    getSystemVendorModels,
    storeSystemApiKey,
    storeSystemVendorConfig,
} from '../services/systemApiKeysService'

const PRIORITY_OPTIONS = Object.values(AIVendor).map((_, i) => i + 1)

type RowState = {
    keyInput: string
    busy: boolean
    message: string | null
    messageKind: 'success' | 'error' | null
    models: string[]
    modelsLoading: boolean
    selectedModel: string
    priority: number | ''
    savingConfig: boolean
}

const emptyRowState = (): RowState => ({
    keyInput: '',
    busy: false,
    message: null,
    messageKind: null,
    models: [],
    modelsLoading: false,
    selectedModel: '',
    priority: '',
    savingConfig: false,
})

export default function SystemApiKeysPage() {
    const { getAccessTokenSilently } = useAuth0()
    const [statuses, setStatuses] = useState<AIVendorAPIKeyStatus[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [rows, setRows] = useState<Record<string, RowState>>(() =>
        Object.fromEntries(Object.values(AIVendor).map((v) => [v, emptyRowState()]))
    )
    // Vendors whose model list has been requested this session (avoid refetch loops)
    const modelsRequestedRef = useRef<Set<string>>(new Set())

    const updateRow = (vendor: AIVendor, patch: Partial<RowState>) =>
        setRows((prev) => ({ ...prev, [vendor]: { ...prev[vendor], ...patch } }))

    const loadModels = useCallback(
        async (vendor: AIVendor) => {
            updateRow(vendor, { modelsLoading: true })
            try {
                const token = await getAccessTokenSilently()
                const response = await getSystemVendorModels(token, vendor)
                updateRow(vendor, { models: response.models, modelsLoading: false })
            } catch (e) {
                updateRow(vendor, {
                    modelsLoading: false,
                    message: e instanceof Error ? e.message : `Failed to load models for ${vendor}`,
                    messageKind: 'error',
                })
            }
        },
        [getAccessTokenSilently]
    )

    const refresh = useCallback(async () => {
        setLoadError(null)
        try {
            const token = await getAccessTokenSilently()
            const response = await getSystemApiKeyStatuses(token)
            setStatuses(response.apiKeyStatuses)

            for (const status of response.apiKeyStatuses) {
                const vendor = status.aiVendor
                // Seed dropdowns with the stored config
                setRows((prev) => ({
                    ...prev,
                    [vendor]: {
                        ...prev[vendor],
                        selectedModel: prev[vendor].selectedModel || status.selectedModel || '',
                        priority: prev[vendor].priority || status.priority || '',
                    },
                }))
                if (status.isAPIKeyValid && !modelsRequestedRef.current.has(vendor)) {
                    modelsRequestedRef.current.add(vendor)
                    void loadModels(vendor)
                }
            }
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Failed to load key statuses')
        } finally {
            setLoading(false)
        }
    }, [getAccessTokenSilently, loadModels])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const handleSave = async (vendor: AIVendor) => {
        const key = rows[vendor].keyInput.trim()
        if (!key) {
            updateRow(vendor, { message: 'Enter an API key first', messageKind: 'error' })
            return
        }
        updateRow(vendor, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            const response = await storeSystemApiKey(token, { aiVendor: vendor, apiKey: key })
            if (response.apiKeyStatus.updateSuccessful) {
                updateRow(vendor, {
                    busy: false,
                    keyInput: '',
                    message: 'Key validated and saved',
                    messageKind: 'success',
                })
                // Reload models with the new key
                modelsRequestedRef.current.add(vendor)
                void loadModels(vendor)
                await refresh()
            } else {
                updateRow(vendor, {
                    busy: false,
                    message: 'Key rejected by vendor — not saved',
                    messageKind: 'error',
                })
            }
        } catch (e) {
            updateRow(vendor, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to save key',
                messageKind: 'error',
            })
        }
    }

    const handleDelete = async (vendor: AIVendor) => {
        if (!window.confirm(`Remove the system ${VENDOR_LABELS[vendor]} API key?`)) return
        updateRow(vendor, { busy: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await deleteSystemApiKey(token, vendor)
            modelsRequestedRef.current.delete(vendor)
            updateRow(vendor, {
                busy: false,
                message: 'Key removed',
                messageKind: 'success',
                models: [],
                selectedModel: '',
                priority: '',
            })
            await refresh()
        } catch (e) {
            updateRow(vendor, {
                busy: false,
                message: e instanceof Error ? e.message : 'Failed to delete key',
                messageKind: 'error',
            })
        }
    }

    const handleSaveConfig = async (vendor: AIVendor) => {
        const row = rows[vendor]
        if (!row.selectedModel || row.priority === '') return
        updateRow(vendor, { savingConfig: true, message: null, messageKind: null })
        try {
            const token = await getAccessTokenSilently()
            await storeSystemVendorConfig(token, {
                aiVendor: vendor,
                model: row.selectedModel,
                priority: row.priority,
            })
            updateRow(vendor, {
                savingConfig: false,
                message: `Saved: ${row.selectedModel} at priority ${row.priority}`,
                messageKind: 'success',
            })
            await refresh()
        } catch (e) {
            updateRow(vendor, {
                savingConfig: false,
                message: e instanceof Error ? e.message : 'Failed to save configuration',
                messageKind: 'error',
            })
        }
    }

    const statusFor = (vendor: AIVendor) => statuses.find((s) => s.aiVendor === vendor)

    if (loading) return <div className="centered">Loading key statuses…</div>

    return (
        <section className="page">
            <h2>System AI Vendor API Keys</h2>

            {loadError && <div className="banner error">{loadError}</div>}

            <div className="vendor-list">
                {Object.values(AIVendor).map((vendor) => {
                    const status = statusFor(vendor)
                    const row = rows[vendor]
                    const isSet = status?.status === 'API key is valid'
                    const savedModel = status?.selectedModel
                    const savedPriority = status?.priority
                    const configDirty =
                        row.selectedModel !== (savedModel ?? '') ||
                        row.priority !== (savedPriority ?? '')
                    return (
                        <div className="vendor-card" key={vendor}>
                            <div className="vendor-card-header">
                                <h3>{VENDOR_LABELS[vendor]}</h3>
                                <div className="header-pills">
                                    {isSet && savedPriority != null && (
                                        <span className="status-pill priority">
                                            Priority {savedPriority}
                                        </span>
                                    )}
                                    <span className={`status-pill ${isSet ? 'ok' : 'unset'}`}>
                                        {isSet ? 'Key set' : 'Not set'}
                                    </span>
                                </div>
                            </div>
                            <div className="vendor-card-body">
                                <input
                                    type="password"
                                    placeholder={isSet ? 'Replace key…' : 'Enter API key…'}
                                    value={row.keyInput}
                                    disabled={row.busy}
                                    onChange={(e) =>
                                        updateRow(vendor, { keyInput: e.target.value })
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleSave(vendor)
                                    }}
                                />
                                <button
                                    className="primary"
                                    disabled={row.busy || !row.keyInput.trim()}
                                    onClick={() => void handleSave(vendor)}
                                >
                                    {row.busy ? 'Saving…' : 'Save'}
                                </button>
                                {isSet && (
                                    <button
                                        className="danger"
                                        disabled={row.busy}
                                        onClick={() => void handleDelete(vendor)}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>

                            {isSet && (
                                <div className="config-row">
                                    <label className="config-field grow">
                                        Model
                                        <select
                                            value={row.selectedModel}
                                            disabled={row.modelsLoading || row.savingConfig}
                                            onChange={(e) =>
                                                updateRow(vendor, { selectedModel: e.target.value })
                                            }
                                        >
                                            <option value="">
                                                {row.modelsLoading
                                                    ? 'Loading models…'
                                                    : 'Select a model…'}
                                            </option>
                                            {/* Keep a stored model visible even if it's missing
                                                from the currently fetched list */}
                                            {row.selectedModel &&
                                                !row.models.includes(row.selectedModel) && (
                                                    <option value={row.selectedModel}>
                                                        {row.selectedModel}
                                                    </option>
                                                )}
                                            {row.models.map((model) => (
                                                <option key={model} value={model}>
                                                    {model}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="config-field">
                                        Priority
                                        <select
                                            value={row.priority}
                                            disabled={row.savingConfig}
                                            onChange={(e) =>
                                                updateRow(vendor, {
                                                    priority: e.target.value
                                                        ? Number(e.target.value)
                                                        : '',
                                                })
                                            }
                                        >
                                            <option value="">—</option>
                                            {PRIORITY_OPTIONS.map((p) => (
                                                <option key={p} value={p}>
                                                    {p}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <button
                                        className="primary"
                                        disabled={
                                            row.savingConfig ||
                                            !row.selectedModel ||
                                            row.priority === '' ||
                                            !configDirty
                                        }
                                        onClick={() => void handleSaveConfig(vendor)}
                                    >
                                        {row.savingConfig ? 'Saving…' : 'Save configuration'}
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
        </section>
    )
}
