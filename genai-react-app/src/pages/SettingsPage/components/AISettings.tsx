import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { storeCustomerVendorApiKey, storeCustomerVendorConfig } from '../../../services/storeCustomerVendorApiKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { AIVendorModelList } from '../../../models/getTextGenerationModels.models'
import { getProviderCatalog, ProviderInfo } from '../../../services/providerCatalogService'
import { InputSelectWithHint, VendorApiKeysManager, VendorApiKeyRowData } from '@genflowly/component-library'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../../components/common/BrandName/BrandName'
import styles from './AISettings.module.scss'

const BRAND_LABEL: Record<string, React.ReactNode> = {
    [AIVendor.OPENAI]: <OpenAIBrandName className={styles.vendorBrand} />,
    [AIVendor.CLAUDE]: <ClaudeBrandName className={styles.vendorBrand} />,
    [AIVendor.GEMINI]: <GeminiBrandName className={styles.vendorBrand} />,
}

// The legacy three vendors are stored/addressed by their uppercase enum
// names; every other provider is stored under its lowercase catalog id
// (the backend normalizes the same way).
const LEGACY_BY_CATALOG_ID: Record<string, string> = {
    openai: AIVendor.OPENAI,
    anthropic: AIVendor.CLAUDE,
    gemini: AIVendor.GEMINI,
}
const storedVendorId = (catalogId: string): string => LEGACY_BY_CATALOG_ID[catalogId] ?? catalogId
const catalogIdFor = (storedId: string): string =>
    Object.entries(LEGACY_BY_CATALOG_ID).find(([, legacy]) => legacy === storedId)?.[0] ?? storedId

export function AISettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        getAccessTokenSilently,
        isAuthenticated,
        updateVendorApiKeyStatus,
        aiVendorAPIKeyStatusList,
        aiConfigPreferences,
        updateAiConfigPreferences,
    } = useAuth()

    const [vendorModels, setVendorModels] = useState<AIVendorModelList[]>([])
    // Vendors without a key stay hidden until picked from the add-vendor
    // dropdown; picking one reveals its card so the key can be entered.
    const [revealedVendors, setRevealedVendors] = useState<string[]>([])
    // BYOK vendor catalog from the backend: every provider the platform can
    // call (native langchain tier + LiteLLM long tail) — any of them works
    // once a key is stored.
    const [catalog, setCatalog] = useState<ProviderInfo[]>([])

    useEffect(() => {
        if (!isAuthenticated || !customerId) return
        let cancelled = false
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                const response = await getProviderCatalog(token)
                if (!cancelled) setCatalog(response.providers)
            } catch (err) {
                console.error('AISettings: failed to fetch provider catalog', err)
            }
        })()
        return () => { cancelled = true }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    const fetchModels = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        // Same localStorage cache as AIVendorWidget / VendorModelSelect
        const cacheKey = `${customerId}_ai_vendor_models`
        const cached = localStorage.getItem(cacheKey)
        if (cached) {
            try {
                const parsed = JSON.parse(cached)
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setVendorModels(parsed)
                    return
                }
            } catch { /* ignore malformed cache */ }
        }
        try {
            const token = await getAccessTokenSilently()
            const response = await getTextGenerationModels(token, customerId, { aiVendor: Object.values(AIVendor) })
            const data = response.aiVendorModelList || []
            setVendorModels(data)
            if (data.length > 0) localStorage.setItem(cacheKey, JSON.stringify(data))
        } catch (err) {
            console.error('AISettings: failed to fetch models', err)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        fetchModels()
    }, [fetchModels])

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
            : (Object.values(AIVendor) as string[]).map(v => ({ id: v, label: v }))
        return source
            .filter(({ id }) => !visibleVendors.includes(id))
            .map(({ id, label }) => ({ label, value: id }))
    }, [catalog, visibleVendors])

    const rows: VendorApiKeyRowData[] = useMemo(() => (
        visibleVendors.map(vendor => {
            const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
            const provider = providerFor(vendor)
            // preferredModels (shared with the sidebar AI-config widget) is the
            // source of truth for the default model; the vendor-config
            // selectedModel is a legacy fallback.
            const preferred = aiConfigPreferences?.preferredModels
                ?.find(m => m.aiVendor === vendor)?.model
            // Legacy vendors keep the live key-scoped model fetch; the long
            // tail lists models from the provider catalog.
            const models = vendorModels.find(vm => vm.aiVendor === vendor)?.modelsList
                ?? provider?.models.map(m => m.name)
                ?? []
            return {
                vendor,
                label: BRAND_LABEL[vendor]
                    ?? <span className={styles.vendorTextLabel}>{provider?.displayName ?? vendor}</span>,
                keySet: isKeySet(vendor),
                savedModel: preferred ?? status?.selectedModel ?? null,
                savedPriority: status?.priority ?? null,
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

    const handleSaveConfig = async (vendor: string, model: string, priority: number) => {
        requireAuth()
        const token = await getAccessTokenSilently()
        // The server mirrors the model into preferredModels; mirror it locally
        // too so the sidebar AI-config widget reflects it this session.
        await storeCustomerVendorConfig(token, { aiVendor: vendor, model, priority })
        const vendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        if (vendorStatus) {
            updateVendorApiKeyStatus({ ...vendorStatus, selectedModel: model, priority })
        }
        const current = aiConfigPreferences?.preferredModels ?? []
        const existing = current.find(m => m.aiVendor === vendor)
        updateAiConfigPreferences({
            preferredModels: [
                ...current.filter(m => m.aiVendor !== vendor),
                { ...existing, aiVendor: vendor as AIVendor, model },
            ],
        })
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.aiSettings.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.aiSettings.subtitle')}</p>
            </div>
            <div className={styles.form}>
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
