import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { VendorApiKeysManager, VendorApiKeyRowData } from '@genflowly/component-library'
import { AIVendor, VENDOR_LABELS } from '../constants/vendors'
import { AIVendorAPIKeyStatus } from '../models/systemApiKeys.models'
import {
    deleteSystemApiKey,
    getSystemApiKeyStatuses,
    getSystemVendorModels,
    storeSystemApiKey,
    storeSystemVendorConfig,
} from '../services/systemApiKeysService'

type ModelsState = { models: string[]; loading: boolean }

export default function SystemApiKeysPage() {
    const { getAccessTokenSilently } = useAuth0()
    const [statuses, setStatuses] = useState<AIVendorAPIKeyStatus[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [modelsByVendor, setModelsByVendor] = useState<Record<string, ModelsState>>({})
    // Vendors whose model list has been requested this session (avoid refetch loops)
    const modelsRequestedRef = useRef<Set<string>>(new Set())

    const loadModels = useCallback(
        async (vendor: AIVendor) => {
            setModelsByVendor((prev) => ({
                ...prev,
                [vendor]: { models: prev[vendor]?.models ?? [], loading: true },
            }))
            try {
                const token = await getAccessTokenSilently()
                const response = await getSystemVendorModels(token, vendor)
                setModelsByVendor((prev) => ({
                    ...prev,
                    [vendor]: { models: response.models, loading: false },
                }))
            } catch {
                setModelsByVendor((prev) => ({
                    ...prev,
                    [vendor]: { models: prev[vendor]?.models ?? [], loading: false },
                }))
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

    const handleSaveKey = async (vendor: string, apiKey: string) => {
        const token = await getAccessTokenSilently()
        const response = await storeSystemApiKey(token, { aiVendor: vendor as AIVendor, apiKey })
        if (response.apiKeyStatus.updateSuccessful) {
            // Reload models with the new key
            modelsRequestedRef.current.add(vendor)
            void loadModels(vendor as AIVendor)
            await refresh()
        }
        return { success: !!response.apiKeyStatus.updateSuccessful }
    }

    const handleDeleteKey = async (vendor: string) => {
        if (!window.confirm(`Remove the system ${VENDOR_LABELS[vendor as AIVendor]} API key?`)) {
            return false
        }
        const token = await getAccessTokenSilently()
        await deleteSystemApiKey(token, vendor as AIVendor)
        modelsRequestedRef.current.delete(vendor)
        setModelsByVendor((prev) => ({ ...prev, [vendor]: { models: [], loading: false } }))
        await refresh()
    }

    const handleSaveConfig = async (vendor: string, model: string, priority: number) => {
        const token = await getAccessTokenSilently()
        await storeSystemVendorConfig(token, { aiVendor: vendor as AIVendor, model, priority })
        await refresh()
    }

    const rows: VendorApiKeyRowData[] = Object.values(AIVendor).map((vendor) => {
        const status = statuses.find((s) => s.aiVendor === vendor)
        return {
            vendor,
            label: VENDOR_LABELS[vendor],
            keySet: status?.status === 'API key is valid',
            savedModel: status?.selectedModel ?? null,
            savedPriority: status?.priority ?? null,
            models: modelsByVendor[vendor]?.models ?? [],
            modelsLoading: modelsByVendor[vendor]?.loading ?? false,
        }
    })

    if (loading) return <div className="centered">Loading key statuses…</div>

    return (
        <section className="page">
            <h2>System AI Vendor API Keys</h2>

            {loadError && <div className="banner error">{loadError}</div>}

            <VendorApiKeysManager
                rows={rows}
                onSaveKey={handleSaveKey}
                onDeleteKey={handleDeleteKey}
                onSaveConfig={handleSaveConfig}
                data-testid="system-api-keys"
            />
        </section>
    )
}
