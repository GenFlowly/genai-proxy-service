import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, SidebarWidget, Switch } from '@genflowly/component-library'
import { useToast } from '../../../../context/ToastContext'
import { useTextGenerationModels } from '../../../../hooks/queries/useTextGenerationModels'
import { useVendorDisplayNames } from '../../../../hooks/useVendorDisplayNames'
import { APIKeyStatus } from '../../../../models/storeCustomerVendorAPIKeys.models'
import { saveAIConfigPreferences } from '../../../../services/saveAIConfigService'
import styles from './AIVendorWidget.module.scss'
import { ICONS } from '../../../../constants/icons'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import { getThinkingLevelInfo } from '../../../../utils/thinkingLevels'

/** The Models card: which vendors answer, with which model and reasoning effort. */
export default function AIVendorWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}): React.ReactElement {
    const { t } = useTranslation()
    const { ai, auth } = useSidebarWidget()
    const { config, setSelectedModelForAIVendor, setThinkingLevelForAIVendor } = ai
    const { getAccessTokenSilently, customerId, isAuthenticated, isSignedOut, aiVendorAPIKeyStatusList } = auth
    const { showToast } = useToast()
    const vendorName = useVendorDisplayNames()

    // Only vendors with a working key are offered — the key-status list
    // carries every vendor the customer configured (legacy three plus any
    // BYOK long-tail vendor), and keyless ones are filtered out entirely.
    const vendors = React.useMemo<string[]>(() => (
        aiVendorAPIKeyStatusList
            .filter(s => s.status === APIKeyStatus.VALID || s.isAPIKeyValid)
            .map(s => s.aiVendor)
    ), [aiVendorAPIKeyStatusList])

    // Shared query (dedups with VendorModelSelect/AISettings): paints from the
    // last known list, skips the round trip entirely when no vendor has a key.
    const { data: modelsData, clearAndRefetch } = useTextGenerationModels(vendors)
    const aiVendorModels = modelsData ?? []
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

    const handleRefresh = async () => {
        if (!customerId) return

        try {
            setIsRefreshing(true)
            await clearAndRefetch()
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
    const noKeysMessage = isSignedOut
        ? t('sidebar.aiVendorWidget.pleaseLogInFirst')
        : t('sidebar.aiVendorWidget.noApiKeysSet')

    const toggleVendor = (vendor: string) => {
        if (!isVendorEnabled(vendor)) return
        if (isAIVendorModelsPopulated(vendor)) {
            setSelectedModelForAIVendor(vendor, '')
        } else {
            const firstModel = getModelsForVendor(vendor)[0]
            if (firstModel) setSelectedModelForAIVendor(vendor, firstModel)
        }
    }

    return (
        <SidebarWidget
            title={t('sidebar.aiVendorWidget.title')}
            icon={ICONS.MODELS}
            actions={(
                <>
                    <IconButton
                        icon={ICONS.REFRESH_ICON}
                        label={hasAnyValidApiKey ? t('sidebar.aiVendorWidget.refreshModels') : noKeysMessage}
                        size="sm"
                        iconClassName={isRefreshing ? styles.spinning : undefined}
                        onClick={handleRefresh}
                        disabled={isRefreshing || !hasAnyValidApiKey}
                        data-testid="refresh-models-button"
                    />
                    <IconButton
                        icon={ICONS.SAVE_ICON}
                        label={hasAnyValidApiKey ? t('sidebar.aiVendorWidget.setAsDefault') : noKeysMessage}
                        size="sm"
                        onClick={handleSave}
                        disabled={isSaving || !hasAnyValidApiKey}
                        data-testid="save-models-button"
                    />
                </>
            )}
            bodyClassName={styles.body}
            data-testid={testId || 'ai-vendor-widget'}
        >
            {vendors.length === 0 && (
                <span className={isSignedOut ? styles.hintText : styles.errorText}>{noKeysMessage}</span>
            )}
            {vendors.map(vendor => {
                const isActive = isAIVendorModelsPopulated(vendor)
                const selectedModel = getSelectedModel(vendor)
                const models = getModelsForVendor(vendor)
                const isEnabled = isVendorEnabled(vendor)
                const reasoningOptions = selectedModel ? getThinkingLevelInfo(selectedModel).options : []

                return (
                    <div key={vendor} className={styles.vendorBlock}>
                        <label className={`${styles.vendorRow} ${isActive ? styles.activeVendor : ''}`}>
                            <Switch
                                checked={isActive && isEnabled}
                                onChange={() => toggleVendor(vendor)}
                                label={vendorName(vendor)}
                                disabled={!isEnabled}
                                data-testid={`vendor-toggle-${vendor}`}
                            />
                            <span className={styles.vendorName}>{vendorName(vendor)}</span>
                        </label>

                        {!isEnabled && (
                            <span className={styles.errorText}>
                                {aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)?.status || APIKeyStatus.NOT_SET}
                            </span>
                        )}

                        {isActive && isEnabled && (models.length > 0 || reasoningOptions.length > 0) && (
                            <div className={styles.vendorSelects}>
                                {models.length > 0 && (
                                    <select
                                        value={selectedModel}
                                        onChange={e => setSelectedModelForAIVendor(vendor, e.target.value)}
                                        className={styles.select}
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
                                {reasoningOptions.length > 0 && (
                                    <select
                                        value={getThinkingLevel(vendor)}
                                        onChange={e => setThinkingLevelForAIVendor(vendor, e.target.value)}
                                        className={styles.select}
                                        aria-label={t('sidebar.aiVendorWidget.reasoning')}
                                        data-testid={`thinking-select-${vendor}`}
                                    >
                                        <option value="">
                                            {t('sidebar.aiVendorWidget.reasoningDefault')}
                                        </option>
                                        {reasoningOptions.map(o => (
                                            <option key={o.value} value={o.value}>
                                                {t(`agentsPage.nodeConfigEditor.thinkingLevel_${o.value}`)}
                                                {o.native ? ` — ${o.native}` : ''}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                        )}

                        {isActive && isEnabled && models.length === 0 && !isRefreshing && (
                            <span className={styles.errorText}>{t('sidebar.aiVendorWidget.noModelsAvailable')}</span>
                        )}
                    </div>
                )
            })}
        </SidebarWidget>
    )
}
