import React, { useEffect, useState, useCallback } from 'react'
import { AIVendor } from '../../../../constants/vendors'
import {
    getTextGenerationModels,
    clearAllModelCache,
} from '../../../../services/getTextGenerationModelsService'
import {
    GetTextGenerationModelsResponse,
    AIVendorModelList,
} from '../../../../models/getTextGenerationModels.models'

import { saveAIConfigPreferences } from '../../../../services/saveAIConfigService'
import styles from './AIVendorWidget.module.scss'
import Tooltip from '../../../common/Tooltip/Tooltip'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import PillButton from '../../../common/PillButton/PillButton'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName,
    CollapsedOpenAIBrandName,
    CollapsedClaudeBrandName,
    CollapsedGeminiBrandName
} from '../../../common/BrandName/BrandName'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'

const vendors = Object.values(AIVendor) as AIVendor[]

export default function AIVendorWidget(): React.ReactElement {
    const { ai, auth } = useSidebarWidget()
    const { config, setSelectedModelForAIVendor, resetConfig } = ai
    const { getAccessTokenSilently, customerId, isAuthenticated, aiVendorAPIKeyStatusList, aiConfigPreferences } = auth

    const [aiVendorModels, setAiVendorModels] = useState<AIVendorModelList[]>([])
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [loadedPreferencesSignature, setLoadedPreferencesSignature] = useState<string>('')

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
        if (!aiConfigPreferences?.preferredModels) return

        const currentSignature = JSON.stringify(aiConfigPreferences.preferredModels)

        if (currentSignature !== loadedPreferencesSignature) {
            // Check if user has already made manual selections (config has active models)
            // If so, do not overwrite with defaults on remount.
            const hasActiveSelection = config.some(c => c.model && c.model.trim() !== '')

            // Only sync if no active selection exists, OR if this is the very first load (signature empty) and we really want defaults?
            // Actually, if signature is empty (mount), and we have active selection (from context persisting), we should SKIP.
            // But we must setLoadedPreferencesSignature to prevent future loops if preferences change?
            // If we skip, we should still update the signature so we track that we "processed" this version.

            if (!hasActiveSelection) {
                console.log('Syncing AI Vendor Preferences', aiConfigPreferences.preferredModels)
                aiConfigPreferences.preferredModels.forEach(pref => {
                    if (pref.aiVendor && pref.model) {
                        setSelectedModelForAIVendor(pref.aiVendor, pref.model)
                    }
                })
            }
            setLoadedPreferencesSignature(currentSignature)
        }
    }, [aiConfigPreferences, loadedPreferencesSignature, setSelectedModelForAIVendor, config])

    // --- Fetch models (with bypass option for refresh) ---
    const fetchModels = useCallback(
        async (forceRefresh = false) => {
            if (!isAuthenticated || !customerId) return

            // If not forcing refresh, check cache first
            if (!forceRefresh) {
                const cachedModels = localStorage.getItem(`${customerId}_ai_vendor_models`)
                if (cachedModels) {
                    try {
                        const parsed = JSON.parse(cachedModels)
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            console.log('Using cached AI models')
                            setAiVendorModels(parsed)
                            return
                        }
                    } catch (e) {
                        console.error('Failed to parse cached ai vendor models', e)
                    }
                }
            }

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

                // Cache the fresh models
                if (customerId && data.length > 0) {
                    localStorage.setItem(`${customerId}_ai_vendor_models`, JSON.stringify(data))
                }
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                // On error, let existing state persist
            }
        },
        [isAuthenticated, customerId, getAccessTokenSilently]
    )

    // --- Load cached models immediately and refresh if needed ---
    // Combined logic to avoid race conditions and double-setting state
    useEffect(() => {
        if (!isAuthenticated || !customerId) return
        fetchModels(false)
    }, [isAuthenticated, customerId, fetchModels])

    // --- Refresh handler ---
    const handleRefresh = async () => {
        if (!customerId) return

        try {
            setIsRefreshing(true)
            resetConfig()
            clearAllModelCache()
            await fetchModels(true)
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

    const hasAnyValidApiKey = vendors.some(isVendorEnabled)

    // Collapsed Content
    const headerCollapsed = (
        <Tooltip content="AI Models" position="left">
            <div className={styles.buttonWrapper}>
                <div className={styles.iconButton} style={{ border: 'none', background: 'transparent', cursor: 'default' }}>
                    <Icon src={ICONS.MODELS} size={24} />
                </div>
            </div>
        </Tooltip>
    )

    const collapsedContent = (
        <>
            {vendors.map(vendor => {
                const isActive = isAIVendorModelsPopulated(vendor)
                const isEnabled = isVendorEnabled(vendor)
                const models = getModelsForVendor(vendor)

                const tooltipContent = !isEnabled ? 'API key not set' : vendor

                let CollapsedBrandComponent = ({ size }: { size?: number }) => <Icon src={ICONS.MODELS} size={size} />
                if (vendor === AIVendor.OPENAI) CollapsedBrandComponent = CollapsedOpenAIBrandName
                if (vendor === AIVendor.CLAUDE) CollapsedBrandComponent = CollapsedClaudeBrandName
                if (vendor === AIVendor.GEMINI) CollapsedBrandComponent = CollapsedGeminiBrandName

                return (
                    <Tooltip key={vendor} content={tooltipContent} position="left">
                        <div className={styles.buttonWrapper}>
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
                                <CollapsedBrandComponent size={20} />
                            </button>
                        </div>
                    </Tooltip>
                )
            })}
        </>
    )

    // Expanded Header
    const header = (
        <div className={styles.header}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                <Icon src={ICONS.MODELS} size={20} />
                <h3 className={styles.title}>AI Models</h3>
            </div>
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
    )

    return (
        <SidebarWidgetContainer
            header={header}
            headerCollapsed={headerCollapsed}
            collapsedContent={collapsedContent}
        >
            <div className={styles.vendorWidget}>
                {vendors.map(vendor => {
                    const isActive = isAIVendorModelsPopulated(vendor)
                    const selectedModel = getSelectedModel(vendor)
                    const models = getModelsForVendor(vendor)
                    const isEnabled = isVendorEnabled(vendor)

                    let BrandComponent: React.ReactNode = vendor
                    if (vendor === AIVendor.OPENAI) BrandComponent = <OpenAIBrandName as="span" />
                    if (vendor === AIVendor.CLAUDE) BrandComponent = <ClaudeBrandName as="span" />
                    if (vendor === AIVendor.GEMINI) BrandComponent = <GeminiBrandName as="span" />

                    return (
                        <div key={vendor} className={styles.vendorBlock}>
                            <PillButton
                                label={BrandComponent}
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
                                variant={isActive ? 'primary' : 'secondary'}
                            />

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
        </SidebarWidgetContainer>
    )
}
