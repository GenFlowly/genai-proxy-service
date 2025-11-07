import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { CacheManager } from '../../../utils/cache'
import styles from './AIVendorWidget.module.scss'
import { GetTextGenerationModelsResponse } from '../../../models/getTextGenerationModels.models'

interface Props {
    collapsed?: boolean
}

const vendors = Object.values(AIVendor) as AIVendor[]

export default function AIVendorWidget({ collapsed = false }: Props): React.ReactElement {
    const { config, setSelectedModelForAIVendor } = useAI()
    const { getAccessTokenSilently, customerId, isAuthenticated } = useAuth()

    const [vendorModels, setVendorModels] = useState<Record<
        AIVendor,
        { models: string[]; loading: boolean; error?: string }
    >>(
        Object.fromEntries(
            vendors.map(v => [v, { models: [], loading: false, error: undefined }])
        ) as unknown as Record<AIVendor, { models: string[]; loading: boolean; error?: string }>
    )


    const isVendorActive = (vendor: AIVendor) =>
        config.some(c => c.aiVendor === vendor && c.model)

    const getSelectedModel = (vendor: AIVendor) =>
        config.find(c => c.aiVendor === vendor)?.model ?? ''

    // --- Load models (cached or remote) ---
    useEffect(() => {
        const fetchModels = async () => {
            if (!isAuthenticated || !customerId) return

            setVendorModels(prev =>
                Object.fromEntries(
                    vendors.map(v => [v, { ...prev[v], loading: true, error: undefined }])
                ) as Record<AIVendor, { models: string[]; loading: boolean; error?: string }>
            )

            try {
                const token = await getAccessTokenSilently()

                const res: GetTextGenerationModelsResponse = await getTextGenerationModels(token, {
                    aiVendor: vendors,
                    customerId,
                })

                const updated: Record<AIVendor, { models: string[]; loading: boolean }> = {
                    ...vendorModels,
                }

                res.aiVendorModelList.forEach(entry => {
                    updated[entry.aiVendor] = {
                        models: entry.modelsList,
                        loading: false,
                    }
                })

                setVendorModels(updated)
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                setVendorModels(prev =>
                    Object.fromEntries(
                        vendors.map(v => [
                            v,
                            { ...prev[v], loading: false, error: 'Failed to load' },
                        ])
                    ) as Record<AIVendor, { models: string[]; loading: boolean; error?: string }>
                )
            }
        }

        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    // --- Collapsed view ---
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
                    onClick={() => window.location.reload()}
                    disabled={Object.values(vendorModels).some(v => v.loading)}
                >
                    ↻ Refresh
                </button>
            </div>

            {vendors.map(vendor => {
                const isActive = isVendorActive(vendor)
                const selectedModel = getSelectedModel(vendor)
                const { models, loading, error } = vendorModels[vendor]
                const disabled = loading || !models.length

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
                                    if (firstModel)
                                        setSelectedModelForAIVendor(vendor, firstModel)
                                }
                            }}
                            disabled={disabled}
                        >
                            {vendor}
                            {loading && <span className={styles.spinner}></span>}
                        </button>

                        {isActive && models.length > 0 && (
                            <select
                                value={selectedModel}
                                onChange={e =>
                                    setSelectedModelForAIVendor(vendor, e.target.value)
                                }
                                className={styles.modelSelect}
                                disabled={loading}
                            >
                                {models.map(model => (
                                    <option key={model} value={model}>
                                        {model}
                                    </option>
                                ))}
                            </select>
                        )}

                        {error && <span className={styles.errorText}>{error}</span>}
                    </div>
                )
            })}
        </div>
    )
}
