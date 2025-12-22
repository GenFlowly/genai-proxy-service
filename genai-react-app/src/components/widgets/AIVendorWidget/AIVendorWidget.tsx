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

import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import styles from './AIVendorWidget.module.scss'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'

interface AIVendorWidgetProps {
    collapsed?: boolean
}

const vendors = Object.values(AIVendor) as AIVendor[]



export default function AIVendorWidget({
    collapsed = false,
}: AIVendorWidgetProps): React.ReactElement {
    const { config, setSelectedModelForAIVendor, resetConfig } = useAI()

    const { getAccessTokenSilently, customerId, isAuthenticated, aiVendorAPIKeyStatusList, aiConfigPreferences } = useAuth()

    const [aiVendorModels, setAiVendorModels] = useState<AIVendorModelList[]>([])
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isPrefsLoaded, setIsPrefsLoaded] = useState(false)

    const isAIVendorModelsPopulated = (aiVendor: AIVendor) =>
        config.some(c => c.aiVendor === aiVendor && c.model)

    const getSelectedModel = (aiVendor: AIVendor) =>
        config.find(c => c.aiVendor === aiVendor)?.model ?? ''

    const isVendorEnabled = (vendor: AIVendor) => {
        const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        return status?.isAPIKeyValid ?? false
    }

    // --- Sync Backend Preferences to AI Context ---
    useEffect(() => {
        if (aiConfigPreferences?.preferredModels && !isPrefsLoaded) {
            aiConfigPreferences.preferredModels.forEach(pref => {
                if (pref.aiVendor && pref.model) {
                    setSelectedModelForAIVendor(pref.aiVendor, pref.model)
                }
            })
            setIsPrefsLoaded(true)
        }
    }, [aiConfigPreferences, isPrefsLoaded, setSelectedModelForAIVendor])

    // --- Fetch models (with bypass option for refresh) ---
    const fetchModels = useCallback(
        async () => {
            if (!isAuthenticated || !customerId) return

            try {
                const token = await getAccessTokenSilently()
                const response: GetTextGenerationModelsResponse =
                    await getTextGenerationModels(
                        token,
                        customerId,
                        { aiVendor: vendors }
                    )

                const data = response.aiVendorModelList || []
                setAiVendorModels(data)

                // Note: We removed local storage cache here as requested previously
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                setAiVendorModels([])
            }
        },
        [isAuthenticated, customerId, getAccessTokenSilently]
    )


    // --- Initial load: fetch models ---
    useEffect(() => {
        if (!isAuthenticated || !customerId) return
        fetchModels()
    }, [isAuthenticated, customerId, fetchModels])

    // --- Refresh handler ---
    const handleRefresh = async () => {
        if (!customerId) return

        try {
            setIsRefreshing(true)
            resetConfig()
            clearAllModelCache()
            await fetchModels()
        } finally {
            setIsRefreshing(false)
        }
    }

    const handleSave = async () => {
        if (!isAuthenticated || !customerId) return

        try {
            setIsSaving(true)
            const token = await getAccessTokenSilently()

            await saveAIConfigPreferences(token, {
                aiConfigPreferences: {
                    preferredModels: config.filter(c => c.model && c.model.trim() !== '')
                }
            })
            alert('Preferences saved successfully!')
        } catch (err: any) {
            console.error('Failed to save preferences:', err)
            alert('Failed to save preferences: ' + err.message)
        } finally {
            setIsSaving(false)
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
                    const isEnabled = isVendorEnabled(vendor)
                    const models = getModelsForVendor(vendor)
                    // If enabled but no models, still technically clickable but might show empty list. 
                    // But if disabled (no API key), it shouldn't be clickable.
                    // Prioritize API key check.

                    const tooltipContent = !isEnabled ? 'API key not set' : vendor

                    return (
                        <Tooltip key={vendor} content={tooltipContent}>
                            <div className={styles.buttonWrapper}> {/* Wrapper for tooltip on disabled button */}
                                <button
                                    type="button"
                                    className={`${styles.iconButton} ${isActive ? styles.active : ''}`}
                                    onClick={() => {
                                        if (!isEnabled) return
                                        if (isActive) {
                                            setSelectedModelForAIVendor(vendor, '')
                                        } else {
                                            const firstModel = models[0]
                                            if (firstModel)
                                                setSelectedModelForAIVendor(vendor, firstModel)
                                        }
                                    }}
                                    disabled={!isEnabled}
                                >
                                    {vendor[0]}
                                </button>
                            </div>
                        </Tooltip>
                    )
                })}
            </div>
        )
    }

    const hasAnyValidApiKey = vendors.some(isVendorEnabled)

    // --- Expanded view ---
    return (
        <div className={styles.vendorWidget}>
            <div className={styles.header}>
                <h3 className={styles.title}>AI Models</h3>
                <div className={styles.actions}>
                    <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : "Refresh Models"}>
                        <button
                            className={styles.iconActionButton}
                            onClick={handleRefresh}
                            disabled={isRefreshing || !hasAnyValidApiKey}
                            aria-label="Refresh Models"
                        >
                            <Icon
                                src={ICONS.REFRESH_ICON}
                                size={20}
                                className={isRefreshing ? styles.spinning : ''}
                            />
                        </button>
                    </Tooltip>

                    <Tooltip content={!hasAnyValidApiKey ? "No API keys set" : "Set as default"}>
                        <button
                            className={styles.iconActionButton}
                            onClick={handleSave}
                            disabled={isSaving || !hasAnyValidApiKey}
                            aria-label="Set as default"
                        >
                            <Icon src={ICONS.SAVE_ICON} size={20} />
                        </button>
                    </Tooltip>
                </div>
            </div>

            {vendors.map(vendor => {
                const isActive = isAIVendorModelsPopulated(vendor)
                const selectedModel = getSelectedModel(vendor)
                const models = getModelsForVendor(vendor)
                const isEnabled = isVendorEnabled(vendor)

                return (
                    <div key={vendor} className={styles.vendorBlock}>
                        <button
                            type="button"
                            className={`${styles.vendorButton} ${isActive ? styles.selected : ''}`}
                            onClick={() => {
                                if (!isEnabled) return
                                if (isActive) {
                                    setSelectedModelForAIVendor(vendor, '')
                                } else {
                                    const firstModel = models[0]
                                    if (firstModel)
                                        setSelectedModelForAIVendor(vendor, firstModel)
                                }
                            }}
                            disabled={!isEnabled}
                        >
                            {vendor}
                        </button>

                        {!isEnabled && (
                            <span className={styles.errorText}>API key not set</span>
                        )}

                        {isActive && isEnabled && models.length > 0 && (
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

                        {isActive && isEnabled && models.length === 0 && (
                            <span className={styles.errorText}>No models available</span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
