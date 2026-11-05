import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor, storedVendorId, catalogIdFor } from '../../../constants/vendors'
import { storeCustomerVendorApiKey, storeCustomerVendorConfig } from '../../../services/storeCustomerVendorApiKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { useProviderCatalog } from '../../../hooks/queries/useProviderCatalog'
import { useTextGenerationModels } from '../../../hooks/queries/useTextGenerationModels'
import { InputSelectWithHint, VendorApiKeysManager, VendorApiKeyRowData } from '@genflowly/component-library'
import { VendorBrandName } from '../../../components/common/BrandName/BrandName'
import { useVendorDisplayNames } from '../../../hooks/useVendorDisplayNames'
import styles from './AISettings.module.scss'

const ALL_VENDOR_IDS = Object.values(AIVendor) as string[]

export function AISettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        getAccessTokenSilently,
        isAuthenticated,
        updateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList,
        aiConfigPreferences,
    } = useAuth()

    const vendorDisplayName = useVendorDisplayNames()
    // Same query/localStorage seed as AIVendorWidget / VendorModelSelect
    const { data: modelsData } = useTextGenerationModels(ALL_VENDOR_IDS)
    const vendorModels = useMemo(() => modelsData ?? [], [modelsData])
    // Vendors without a key stay hidden until picked from the add-vendor
    // dropdown; picking one reveals its card so the key can be entered.
    const [revealedVendors, setRevealedVendors] = useState<string[]>([])
    // BYOK vendor catalog from the backend: every provider the platform can
    // call (native langchain tier + LiteLLM long tail) — any of them works
    // once a key is stored.
    const { data: catalogData } = useProviderCatalog()
    const catalog = useMemo(() => catalogData?.providers ?? [], [catalogData])

    const isKeySet = useCallback((vendor: string) => {
        const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        return status?.status === APIKeyStatus.VALID || !!status?.isAPIKeyValid
    }, [aiVendorAPIKeyStatusList])

    const providerFor = useCallback(
        (storedId: string) => catalog.find(p => p.id === catalogIdFor(storedId)),
        [catalog]
    )

    // Cards only for vendors with a saved key (the status list carries every
    // stored vendor, long tail included) or explicitly added this session
    const visibleVendors = useMemo(() => {
        const withKeys = aiVendorAPIKeyStatusList
            .filter(s => s.status === APIKeyStatus.VALID || s.isAPIKeyValid)
            .map(s => s.aiVendor)
        return [...withKeys, ...revealedVendors.filter(v => !withKeys.includes(v))]
    }, [aiVendorAPIKeyStatusList, revealedVendors])

    const addableVendorOptions = useMemo(() => {
        // Catalog still loading/failed → at least the legacy three are addable
        const source = catalog.length > 0
            ? catalog.map(p => ({ id: storedVendorId(p.id), label: p.displayName }))
            : (Object.values(AIVendor) as string[]).map(v => ({ id: v, label: vendorDisplayName(v) }))
        return source
            .filter(({ id }) => !visibleVendors.includes(id))
            .map(({ id, label }) => ({ label, value: id }))
    }, [catalog, visibleVendors, vendorDisplayName])

    const rows: VendorApiKeyRowData[] = useMemo(() => (
        visibleVendors.map(vendor => {
            const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
            const provider = providerFor(vendor)
            // preferredModels (shared with the sidebar AI-config widget) is the
            // source of truth for the default model; the vendor-config
            // selectedModel is a legacy fallback.
            const preferredEntry = aiConfigPreferences?.preferredModels
                ?.find(m => m.aiVendor === vendor)
            const preferred = preferredEntry?.model
            // Legacy vendors keep the live key-scoped model fetch; the long
            // tail lists models from the provider catalog, as does a legacy
            // vendor while its live list is empty (a key was only just saved).
            const liveModels = vendorModels.find(vm => vm.aiVendor === vendor)?.modelsList
            const models = liveModels?.length
                ? liveModels
                : provider?.models.map(m => m.name) ?? []
            return {
                vendor,
                label: <VendorBrandName vendorId={vendor} className={styles.vendorBrand} />,
                keySet: isKeySet(vendor),
                savedModel: preferred ?? status?.selectedModel ?? null,
                savedPriority: status?.priority ?? null,
                savedThinkingLevel: preferredEntry?.thinkingLevel ?? status?.thinkingLevel ?? '',
                models,
            }
        })
    ), [visibleVendors, isKeySet, providerFor, aiVendorAPIKeyStatusList, vendorModels, aiConfigPreferences])

    const requireAuth = () => {
        if (!isAuthenticated || !customerId) {
            throw new Error(t('settingsPage.aiSettings.loginFirstToast'))
        }
    }

    const handleSaveKey = async (vendor: string, apiKey: string) => {
        requireAuth()
        const token = await getAccessTokenSilently()
        const response = await storeCustomerVendorApiKey(token, { aiVendor: vendor, apiKey })
        if (response.apiKeyStatus.updateSuccessful) {
            updateVendorApiKeyStatus(response.apiKeyStatus)
        }
        return {
            success: response.apiKeyStatus.updateSuccessful,
            // The provider's own rejection ("account suspended, recharge")
            // beats the generic invalid-key status when validation fails
            message: response.apiKeyStatus.detail || response.apiKeyStatus.status,
        }
    }

    const handleSaveConfig = async (
        vendor: string,
        model: string,
        priority: number,
        thinkingLevel: string
    ) => {
        requireAuth()
        const token = await getAccessTokenSilently()
        // storeCustomerVendorConfig writes through to the preferences store
        // itself, so no local preferredModels mirroring here.
        await storeCustomerVendorConfig(token, { aiVendor: vendor, model, priority, thinkingLevel })
        const vendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        if (vendorStatus) {
            updateVendorApiKeyStatus({
                ...vendorStatus,
                selectedModel: model,
                priority,
                thinkingLevel: thinkingLevel || null,
            })
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.form}>
                <p className={styles.primaryNote} data-testid="ai-settings-primary-note">
                    {t('settingsPage.aiSettings.primaryProviderNote')}
                </p>
                <VendorApiKeysManager
                    rows={rows}
                    onSaveKey={handleSaveKey}
                    onSaveConfig={handleSaveConfig}
                    strings={{
                        keySetPill: t('settingsPage.aiSettings.keySetPill'),
                        keyNotSetPill: t('settingsPage.aiSettings.keyNotSetPill'),
                        keyHint: t('settingsPage.aiSettings.apiKeyHint'),
                        keyPlaceholder: 'sk-...',
                        keyReplacePlaceholder: t('settingsPage.aiSettings.overwriteApiKey'),
                        saveKey: t('settingsPage.aiSettings.save'),
                        saving: t('settingsPage.aiSettings.savingLabel'),
                        keyEmpty: t('settingsPage.aiSettings.enterValidApiKeyToast'),
                        modelHint: t('settingsPage.aiSettings.configModelHint'),
                        modelPlaceholder: t('settingsPage.aiSettings.configModelPlaceholder'),
                        priorityHint: t('settingsPage.aiSettings.configPriorityHint'),
                        saveConfig: t('settingsPage.aiSettings.configSave'),
                        configSaved: () => t('settingsPage.aiSettings.configSavedToast'),
                    }}
                    data-testid="ai-settings-vendors"
                />

                {addableVendorOptions.length > 0 && (
                    <div className={styles.addVendorField}>
                        <label className={styles.addVendorLabel}>
                            {t('settingsPage.aiSettings.addVendorLabel')}
                        </label>
                        <InputSelectWithHint
                            hint={t('settingsPage.aiSettings.addVendorHint')}
                            placeholder={t('settingsPage.aiSettings.addVendorPlaceholder')}
                            value=""
                            onChange={(val: string) =>
                                setRevealedVendors(prev => [...prev, val])}
                            options={addableVendorOptions}
                            data-testid="add-vendor-select"
                        />
                    </div>
                )}
            </div>
        </div>
    )
}
