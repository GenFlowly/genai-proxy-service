import React, { useEffect, useState, useCallback } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import {
    getTextGenerationModels,
    clearAllModelCache,
} from '../../../services/getTextGenerationModelsService'
import {
    GetTextGenerationModelsResponse,
    AIVendorModelList,
} from '../../../models/getTextGenerationModels.models'
import { CacheManager } from '../../../utils/cache'
import styles from './AIVendorWidget.module.scss'

interface AIVendorWidgetProps {
    collapsed?: boolean
}

const vendors = Object.values(AIVendor) as AIVendor[]

// 🧠 Cache 1: for selected model states (UI-level)
const aiConfigCache = new CacheManager({ prefix: 'aiConfigCache_' })

export default function AIVendorWidget({
                                           collapsed = false,
                                       }: AIVendorWidgetProps): React.ReactElement {
    const { config, setSelectedModelForAIVendor, resetConfig } = useAI()

    const { getAccessTokenSilently, customerId, isAuthenticated } = useAuth()

    const [aiVendorModels, setAiVendorModels] = useState<AIVendorModelList[]>([])
    const [isRefreshing, setIsRefreshing] = useState(false)

    const isAIVendorModelsPopulated = (aiVendor: AIVendor) =>
        config.some(c => c.aiVendor === aiVendor && c.model)

    const getSelectedModel = (aiVendor: AIVendor) =>
        config.find(c => c.aiVendor === aiVendor)?.model ?? ''

    // --- Fetch models (with bypass option for refresh) ---
    const fetchModels = useCallback(
        async (bypassCache = false) => {
            if (!isAuthenticated || !customerId) return

            try {
                const token = await getAccessTokenSilently()
                const response: GetTextGenerationModelsResponse =
                    await getTextGenerationModels(
                        token,
                        customerId,
                        { aiVendor: vendors },
                        bypassCache
                    )

                const data = response.aiVendorModelList || []
                setAiVendorModels(data)

                // ✅ Update UI cache
                aiConfigCache.set('aiVendorModels', data)
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                setAiVendorModels([])
            }
        },
        [isAuthenticated, customerId, getAccessTokenSilently]
    )

    // --- Initial load: use cache or fetch ---
    useEffect(() => {
        if (!isAuthenticated || !customerId) return

        const cached = aiConfigCache.get<AIVendorModelList[]>('aiVendorModels')
        if (cached && cached.length > 0) {
            setAiVendorModels(cached)
        } else {
            fetchModels()
        }
    }, [isAuthenticated, customerId, fetchModels])

    // --- Refresh handler ---
    const handleRefresh = async () => {
        if (!customerId) return

        try {
            setIsRefreshing(true)

            // ✅ 1. Clear both caches
            aiConfigCache.clear()
            clearAllModelCache()

            // ✅ 2. Reset selected models in AI context
            resetConfig()

            // ✅ 3. Fetch from API again (bypass cache)
            await fetchModels(true)
        } finally {
            setIsRefreshing(false)
        }
    }


    const getModelsForVendor = (vendor: AIVendor): string[] =>
        aiVendorModels.find(v => v.aiVendor === vendor)?.modelsList ?? []

    // --- Collapsed view ---
    if (collapsed) {
        return (
            <div className={`${styles.vendorWidget} ${styles.collapsed}`}>
                {vendors.map(vendor => {
                    const isActive = isAIVendorModelsPopulated(vendor)
                    const models = getModelsForVendor(vendor)
                    const disabled = models.length === 0

                    return (
                        <button
                            key={vendor}
                            type="button"
                            className={`${styles.iconButton} ${isActive ? styles.active : ''}`}
                            onClick={() => {
                                if (disabled) return
                                if (isActive) {
                                    setSelectedModelForAIVendor(vendor, '')
                                } else {
                                    const firstModel = models[0]
                                    if (firstModel)
                                        setSelectedModelForAIVendor(vendor, firstModel)
                                }
                            }}
                            title={vendor}
                            disabled={disabled}
                        >
                            {vendor[0]}
                        </button>
                    )
                })}
            </div>
        )
    }

    // --- Expanded view ---
    return (
        <div className={styles.vendorWidget}>
            <div className={styles.header}>
                <h3 className={styles.title}>AI Models</h3>
                <button
                    className={styles.refreshButton}
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                >
                    {isRefreshing ? 'Refreshing...' : '↻ Refresh'}
                </button>
            </div>

            {vendors.map(vendor => {
                const isActive = isAIVendorModelsPopulated(vendor)
                const selectedModel = getSelectedModel(vendor)
                const models = getModelsForVendor(vendor)
                const disabled = models.length === 0

                return (
                    <div key={vendor} className={styles.vendorBlock}>
                        <button
                            type="button"
                            className={`${styles.vendorButton} ${
                                isActive ? styles.selected : ''
                            }`}
                            onClick={() => {
                                if (disabled) return
                                if (isActive) {
                                    setSelectedModelForAIVendor(vendor, '')
                                } else {
                                    const firstModel = models[0]
                                    if (firstModel)
                                        setSelectedModelForAIVendor(vendor, firstModel)
                                }
                            }}
                            disabled={disabled}
                        >
                            {vendor}
                        </button>

                        {isActive && models.length > 0 && (
                            <select
                                value={selectedModel}
                                onChange={e =>
                                    setSelectedModelForAIVendor(vendor, e.target.value)
                                }
                                className={styles.modelSelect}
                            >
                                {models.map(model => (
                                    <option key={model} value={model}>
                                        {model}
                                    </option>
                                ))}
                            </select>
                        )}

                        {!isActive && models.length === 0 && (
                            <span className={styles.errorText}>No models available</span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
