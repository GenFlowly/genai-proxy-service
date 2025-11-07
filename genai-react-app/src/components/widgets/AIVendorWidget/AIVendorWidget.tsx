import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import {
    getTextGenerationModels,
} from '../../../services/getTextGenerationModelsService'
import { CacheManager } from '../../../utils/cache'
import styles from './AIVendorWidget.module.scss'
import {
    GetTextGenerationModelsResponse
} from "../../../models/getTextGenerationModels.models";

interface Props {
    collapsed?: boolean
}

const modelCache = new CacheManager({
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    prefix: 'ai_models_',
})

function getCacheKey(vendor: AIVendor, customerId: string): string {
    return `${vendor}_${customerId}`
}

export default function AIVendorWidget({ collapsed = false }: Props): React.ReactElement {
    const { config, setSelectedModelForAIVendor } = useAI()
    const { getAccessTokenSilently, customerId, isAuthenticated } = useAuth()

    const [vendorModels, setVendorModels] = useState<
        Record<AIVendor, { models: string[]; loading: boolean; error?: string }>
    >({
        [AIVendor.OPENAI]: { models: [], loading: false },
        [AIVendor.CLAUDE]: { models: [], loading: false },
        [AIVendor.GEMINI]: { models: [], loading: false },
    })

    const vendors = Object.values(AIVendor) as AIVendor[]

    const isVendorActive = (vendor: AIVendor) =>
        config.some(c => c.aiVendor === vendor && c.model)

    const getSelectedModel = (vendor: AIVendor) =>
        config.find(c => c.aiVendor === vendor)?.model ?? ''

    // --- Load cached model lists ---
    useEffect(() => {
        if (!customerId) return
        const updated = { ...vendorModels }
        vendors.forEach(vendor => {
            const cached = modelCache.get<GetTextGenerationModelsResponse>(getCacheKey(vendor, customerId))
            if (cached?.modelsList?.length) {
                updated[vendor].models = cached.modelsList
            }
        })
        setVendorModels(updated)
    }, [customerId])

    // --- Fetch models from backend ---
    useEffect(() => {
        const fetchModels = async () => {
            if (!isAuthenticated || !customerId) return
            try {
                const token = await getAccessTokenSilently()
                for (const aiVendor of vendors) {
                    setVendorModels(prev => ({
                        ...prev,
                        [aiVendor]: { ...prev[aiVendor], loading: true, error: undefined },
                    }))
                    try {
                        const res = await getTextGenerationModels(token, { aiVendor, customerId })
                        setVendorModels(prev => ({
                            ...prev,
                            [aiVendor]: { loading: false, models: res.modelsList ?? [] },
                        }))
                        modelCache.set(getCacheKey(aiVendor, customerId), res)
                    } catch (err) {
                        console.error(err)
                        setVendorModels(prev => ({
                            ...prev,
                            [aiVendor]: { loading: false, models: [], error: 'Failed to load' },
                        }))
                    }
                }
            } catch (err) {
                console.error('Model fetch error:', err)
            }
        }
        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    // --- Compact (collapsed) mode ---
    if (collapsed) {
        return (
            <div className={`${styles.vendorWidget} ${styles.collapsed}`}>
                {vendors.map(vendor => {
                    const isActive = isVendorActive(vendor)
                    const models = vendorModels[vendor].models
                    const disabled = vendorModels[vendor].loading || !models.length

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
                                    if (firstModel) setSelectedModelForAIVendor(vendor, firstModel)
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

    // --- Expanded (normal) mode ---
    return (
        <div className={styles.vendorWidget}>
            <div className={styles.header}>
                <h3 className={styles.title}>AI Models</h3>
                <button
                    className={styles.refreshButton}
                    onClick={() => window.location.reload()}
                    disabled={Object.values(vendorModels).some(v => v.loading)}
                >
                    ↻ Refresh
                </button>
            </div>

            {vendors.map(vendor => {
                const isActive = isVendorActive(vendor)
                const selectedModel = getSelectedModel(vendor)
                const models = vendorModels[vendor].models
                const disabled = vendorModels[vendor].loading || !models.length

                return (
                    <div key={vendor} className={styles.vendorBlock}>
                        <button
                            type="button"
                            className={`${styles.vendorButton} ${isActive ? styles.selected : ''}`}
                            onClick={() => {
                                if (disabled) return
                                if (isActive) {
                                    setSelectedModelForAIVendor(vendor, '')
                                } else {
                                    const firstModel = models[0]
                                    if (firstModel) setSelectedModelForAIVendor(vendor, firstModel)
                                }
                            }}
                            disabled={disabled}
                        >
                            {vendor}
                            {vendorModels[vendor].loading && <span className={styles.spinner}></span>}
                        </button>

                        {isActive && models.length > 0 && (
                            <select
                                value={selectedModel}
                                onChange={e => setSelectedModelForAIVendor(vendor, e.target.value)}
                                className={styles.modelSelect}
                                disabled={vendorModels[vendor].loading}
                            >
                                {models.map(model => (
                                    <option key={model} value={model}>
                                        {model}
                                    </option>
                                ))}
                            </select>
                        )}

                        {vendorModels[vendor].error && (
                            <span className={styles.errorText}>{vendorModels[vendor].error}</span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
