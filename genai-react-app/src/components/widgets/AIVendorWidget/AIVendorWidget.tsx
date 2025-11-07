import React, { useEffect, useState } from 'react'
import { useAI } from '../../../context/AIContext'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { GetTextGenerationModelsResponse, AIVendorModelList } from '../../../models/getTextGenerationModels.models'
import styles from './AIVendorWidget.module.scss'

interface Props {
    collapsed?: boolean
}

const vendors = Object.values(AIVendor) as AIVendor[]

export default function AIVendorWidget({ collapsed = false }: Props): React.ReactElement {
    const { config, setSelectedModelForAIVendor } = useAI()
    const { getAccessTokenSilently, customerId, isAuthenticated } = useAuth()

    const [vendorModels, setVendorModels] = useState<AIVendorModelList[]>([])

    const isVendorActive = (vendor: AIVendor) =>
        config.some(c => c.aiVendor === vendor && c.model)

    const getSelectedModel = (vendor: AIVendor) =>
        config.find(c => c.aiVendor === vendor)?.model ?? ''

    // --- Load models (cached or remote) ---
    useEffect(() => {
        const fetchModels = async () => {
            if (!isAuthenticated || !customerId) return

            try {
                const token = await getAccessTokenSilently()
                const res: GetTextGenerationModelsResponse = await getTextGenerationModels(token, {
                    aiVendor: vendors,
                    customerId,
                })

                setVendorModels(res.aiVendorModelList || [])
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                setVendorModels([])
            }
        }

        fetchModels()
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    const getModelsForVendor = (vendor: AIVendor): string[] => {
        return vendorModels.find(v => v.aiVendor === vendor)?.modelsList ?? []
    }

    // --- Collapsed view ---
    if (collapsed) {
        return (
            <div className={`${styles.vendorWidget} ${styles.collapsed}`}>
                {vendors.map(vendor => {
                    const isActive = isVendorActive(vendor)
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
                    onClick={() => window.location.reload()}
                >
                    ↻ Refresh
                </button>
            </div>

            {vendors.map(vendor => {
                const isActive = isVendorActive(vendor)
                const selectedModel = getSelectedModel(vendor)
                const models = getModelsForVendor(vendor)
                const disabled = models.length === 0

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
