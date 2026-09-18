import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { storeCustomerVendorApiKey, storeCustomerVendorConfig } from '../../../services/storeCustomerVendorApiKeysService'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { getTextGenerationModels } from '../../../services/getTextGenerationModelsService'
import { AIVendorModelList } from '../../../models/getTextGenerationModels.models'
import { VendorApiKeysManager, VendorApiKeyRowData } from '@genflowly/component-library'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../../components/common/BrandName/BrandName'
import styles from './AISettings.module.scss'

const BRAND_LABEL: Record<AIVendor, React.ReactNode> = {
    [AIVendor.OPENAI]: <OpenAIBrandName className={styles.vendorBrand} />,
    [AIVendor.CLAUDE]: <ClaudeBrandName className={styles.vendorBrand} />,
    [AIVendor.GEMINI]: <GeminiBrandName className={styles.vendorBrand} />,
}

export function AISettings(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, getAccessTokenSilently, isAuthenticated, updateVendorApiKeyStatus, aiVendorAPIKeyStatusList } = useAuth()

    const [vendorModels, setVendorModels] = useState<AIVendorModelList[]>([])

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

    const rows: VendorApiKeyRowData[] = useMemo(() => (
        (Object.values(AIVendor) as AIVendor[]).map(vendor => {
            const status = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
            return {
                vendor,
                label: BRAND_LABEL[vendor],
                keySet: status?.status === APIKeyStatus.VALID || !!status?.isAPIKeyValid,
                savedModel: status?.selectedModel ?? null,
                savedPriority: status?.priority ?? null,
                models: vendorModels.find(vm => vm.aiVendor === vendor)?.modelsList ?? [],
            }
        })
    ), [aiVendorAPIKeyStatusList, vendorModels])

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
            message: response.apiKeyStatus.status,
        }
    }

    const handleSaveConfig = async (vendor: string, model: string, priority: number) => {
        requireAuth()
        const token = await getAccessTokenSilently()
        await storeCustomerVendorConfig(token, { aiVendor: vendor, model, priority })
        const vendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === vendor)
        if (vendorStatus) {
            updateVendorApiKeyStatus({ ...vendorStatus, selectedModel: model, priority })
        }
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
            </div>
        </div>
    )
}
