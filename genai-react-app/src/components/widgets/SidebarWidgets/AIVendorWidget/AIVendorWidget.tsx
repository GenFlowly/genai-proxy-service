import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../../../context/ToastContext'
import { getTextGenerationModels } from '../../../../services/getTextGenerationModelsService'
import {
    GetTextGenerationModelsResponse,
    AIVendorModelList,
} from '../../../../models/getTextGenerationModels.models'

import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models'

import { saveAIConfigPreferences } from '../../../../services/saveAIConfigService'
import styles from './AIVendorWidget.module.scss'
import { Tooltip } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../../constants/icons'
import { PillButton } from '@genflowly/component-library'
import {
    VendorBrandName,
    CollapsedVendorBrandName
} from '../../../common/BrandName/BrandName'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import { getThinkingLevelInfo } from '../../../../utils/thinkingLevels'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'

export default function AIVendorWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}): React.ReactElement {
    const { t } = useTranslation()
    const { ai, auth } = useSidebarWidget()
    const { config, setSelectedModelForAIVendor, setThinkingLevelForAIVendor, resetConfig } = ai
    const { getAccessTokenSilently, customerId, isAuthenticated, aiVendorAPIKeyStatusList } = auth
    const { showToast } = useToast()

    // Only vendors with a working key are offered — the key-status list
    // carries every vendor the customer configured (legacy three plus any
    // BYOK long-tail vendor), and keyless ones are filtered out entirely.
    const vendors = React.useMemo<string[]>(() => (
        aiVendorAPIKeyStatusList
            .filter(s => s.status === APIKeyStatus.VALID || s.isAPIKeyValid)
            .map(s => s.aiVendor)
    ), [aiVendorAPIKeyStatusList])

    const [aiVendorModels, setAiVendorModels] = useState<AIVendorModelList[]>([])
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)

    const isAIVendorModelsPopulated = (aiVendor: string) =>
        config.some(c => c.aiVendor === aiVendor && c.model)

    const getSelectedModel = (aiVendor: string) =>
        config.find(c => c.aiVendor === aiVendor)?.model ?? ''

    const getThinkingLevel = (aiVendor: string): string =>
        config.find(c => c.aiVendor === aiVendor)?.thinkingLevel ?? ''

    const isVendorEnabled = (vendor: string) => {
        const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        return status?.status === APIKeyStatus.VALID
    }

    // Backend preference → config sync now lives in AIContext, so model
    // selections exist even before this widget first mounts (mobile).

    // --- Fetch models (with bypass option for refresh) ---
    const fetchModels = useCallback(
        async (forceRefresh = false) => {
            if (!isAuthenticated || !customerId) return
            // No valid keys → the server can only answer with an empty list;
            // skip the round trip entirely.
            if (vendors.length === 0) {
                setAiVendorModels([])
                return
            }

            let cachedData: AIVendorModelList[] | null = null

            // If not forcing refresh, check cache first
            if (!forceRefresh) {
                const cachedModels = localStorage.getItem(`${customerId}_ai_vendor_models`)
                if (cachedModels) {
                    try {
                        const parsed = JSON.parse(cachedModels)
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            console.log('Using cached AI models (initial load)')
                            setAiVendorModels(parsed)
                            cachedData = parsed
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

                const newData = response.aiVendorModelList || []

                // Compare with cache/current state to determine if update is needed
                // Simple JSON stringify comparison is sufficient here as structure is simple
                const isDifferent = JSON.stringify(newData) !== JSON.stringify(cachedData)

                if (isDifferent) {
                    console.log('Remote models differ from cache, updating...')
                    setAiVendorModels(newData)

                    // Cache the fresh models
                    if (customerId && newData.length > 0) {
                        localStorage.setItem(`${customerId}_ai_vendor_models`, JSON.stringify(newData))
                    }
                } else {
                    console.log('Remote models are identical to cache, skipping update.')
                }
            } catch (err) {
                console.error('Failed to fetch AI models:', err)
                // On error, let existing state persist
            }
        },
        [isAuthenticated, customerId, getAccessTokenSilently, vendors]
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
            showToast(t('sidebar.aiVendorWidget.preferencesSavedSuccessfully'))
        } catch (err: any) {
            console.error('Failed to save preferences:', err)
            showToast(t('sidebar.aiVendorWidget.failedToSavePreferences', { message: err.message }))
        } finally {
            setIsSaving(false)
        }
    }


    const getModelsForVendor = (vendor: string): string[] =>
        aiVendorModels.find(v => v.aiVendor === vendor)?.modelsList ?? []

    const hasAnyValidApiKey = vendors.some(isVendorEnabled)

    // Collapsed Content
    const headerCollapsed = (
        <Tooltip content={t('sidebar.aiVendorWidget.aiModelsTooltip')} position="left">
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

                const tooltipContent = !isEnabled ? t('sidebar.aiVendorWidget.apiKeyNotSet') : vendor

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
                                <CollapsedVendorBrandName vendorId={vendor} size={20} />
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
                <h3 className={styles.title}>{t('sidebar.aiVendorWidget.title')}</h3>
            </div>
            <div className={styles.actions}>
                <Tooltip content={!hasAnyValidApiKey ? t('sidebar.aiVendorWidget.noApiKeysSet') : t('sidebar.aiVendorWidget.refreshModels')}>
                    <button
                        className={styles.iconActionButton}
                        onClick={handleRefresh}
                        disabled={isRefreshing || !hasAnyValidApiKey}
                        aria-label={t('sidebar.aiVendorWidget.refreshModels')}
                        data-testid="refresh-models-button"
                    >
                        <Icon
                            src={ICONS.REFRESH_ICON}
                            size={20}
                            className={isRefreshing ? styles.spinning : ''}
                        />
                    </button>
                </Tooltip>

                <Tooltip content={!hasAnyValidApiKey ? t('sidebar.aiVendorWidget.noApiKeysSet') : t('sidebar.aiVendorWidget.setAsDefault')}>
                    <button
                        className={styles.iconActionButton}
                        onClick={handleSave}
                        disabled={isSaving || !hasAnyValidApiKey}
                        aria-label={t('sidebar.aiVendorWidget.setAsDefault')}
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
            data-testid={testId || "ai-vendor-widget"}
        >
            <div className={styles.vendorWidget}>
                {vendors.length === 0 && (
                    <span className={styles.errorText}>{t('sidebar.aiVendorWidget.noApiKeysSet')}</span>
                )}
                {vendors.map(vendor => {
                    const isActive = isAIVendorModelsPopulated(vendor)
                    const selectedModel = getSelectedModel(vendor)
                    const models = getModelsForVendor(vendor)
                    const isEnabled = isVendorEnabled(vendor)

                    const BrandComponent: React.ReactNode = <VendorBrandName vendorId={vendor} as="span" />

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
                                data-testid={`vendor-toggle-${vendor}`}
                            />

                            {!isEnabled && (
                                <span className={styles.errorText}>
                                    {aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)?.status || APIKeyStatus.NOT_SET}
                                </span>
                            )}

                            {isActive && isEnabled && models.length > 0 && (
                                <select
                                    value={selectedModel}
                                    onChange={e =>
                                        setSelectedModelForAIVendor(vendor, e.target.value)
                                    }
                                    className={styles.modelSelect}
                                    data-testid={`model-select-${vendor}`}
                                >
                                    {models.map(model => (
                                        <option key={model} value={model}>
                                            {model}
                                        </option>
                                    ))}
                                </select>
                            )}

                            {/* Reasoning effort for this vendor's responses; rides the
                                request's aiConfig and overrides the agent's node-level
                                thinking_level on the response generator. */}
                            {isActive && isEnabled && selectedModel &&
                                getThinkingLevelInfo(selectedModel).options.length > 0 && (
                                <select
                                    value={getThinkingLevel(vendor)}
                                    onChange={e =>
                                        setThinkingLevelForAIVendor(vendor, e.target.value)
                                    }
                                    className={styles.modelSelect}
                                    aria-label={t('sidebar.aiVendorWidget.reasoning')}
                                    data-testid={`thinking-select-${vendor}`}
                                >
                                    <option value="">
                                        {t('sidebar.aiVendorWidget.reasoningDefault')}
                                    </option>
                                    {getThinkingLevelInfo(selectedModel).options.map(o => (
                                        <option key={o.value} value={o.value}>
                                            {t(`agentsPage.nodeConfigEditor.thinkingLevel_${o.value}`)}
                                            {o.native ? ` — ${o.native}` : ''}
                                        </option>
                                    ))}
                                </select>
                            )}

                            {isActive && isEnabled && models.length === 0 && (
                                <span className={styles.errorText}>{t('sidebar.aiVendorWidget.noModelsAvailable')}</span>
                            )}
                        </div>
                    )
                })}
            </div>
        </SidebarWidgetContainer>
    )
}
