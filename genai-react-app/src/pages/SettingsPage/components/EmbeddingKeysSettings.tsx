import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import {
    EmbeddingKeyStatus,
    EmbeddingVendor,
    getEmbeddingKeys,
    storeEmbeddingKey,
} from '../../../services/embeddingKeysService'
import {
    VendorApiKeysManager,
    VendorApiKeyRowData,
} from '@genflowly/component-library'
import { VendorBrandName } from '../../../components/common/BrandName/BrandName'
import styles from './EmbeddingKeysSettings.module.scss'

/**
 * Bring-your-own API keys for the embedding models that index and search the
 * customer's data. The OpenAI key is the same key as on the LLM API Keys
 * page (one key serves generation and embeddings), so it reads and writes the
 * shared vendor-key state; Voyage is embedding-only and has its own key.
 * The per-category default embedding models live on the Defaults page.
 */
export function EmbeddingKeysSettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        isAuthenticated,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        updateVendorApiKeyStatus,
    } = useAuth()

    const [voyageStatus, setVoyageStatus] = useState<EmbeddingKeyStatus | null>(null)

    const loadStatuses = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            const token = await getAccessTokenSilently()
            const response = await getEmbeddingKeys(token)
            setVoyageStatus(response.statuses.find(s => s.vendor === EmbeddingVendor.VOYAGE) ?? null)
        } catch (err) {
            console.error('EmbeddingKeysSettings: failed to fetch key statuses', err)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        void loadStatuses()
    }, [loadStatuses])

    // OpenAI state lives in the shared vendor-key list, so a key stored on
    // the LLM API Keys page shows as set here (and vice versa)
    const openAiVendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === AIVendor.OPENAI)
    const openAiKeySet =
        openAiVendorStatus?.status === APIKeyStatus.VALID || !!openAiVendorStatus?.isAPIKeyValid

    const rows: VendorApiKeyRowData[] = useMemo(() => ([
        {
            vendor: EmbeddingVendor.OPENAI,
            label: <VendorBrandName vendorId={EmbeddingVendor.OPENAI} className={styles.vendorBrand} />,
            keySet: openAiKeySet,
        },
        {
            vendor: EmbeddingVendor.VOYAGE,
            label: t('settingsPage.embeddingKeysSettings.voyageLabel'),
            keySet: voyageStatus?.status === APIKeyStatus.VALID || !!voyageStatus?.isAPIKeyValid,
        },
    ]), [openAiKeySet, voyageStatus, t])

    const handleSaveKey = async (vendor: string, apiKey: string) => {
        if (!isAuthenticated || !customerId) {
            throw new Error(t('settingsPage.aiSettings.loginFirstToast'))
        }
        const token = await getAccessTokenSilently()

        if (vendor === EmbeddingVendor.OPENAI) {
            // Same endpoint as the LLM API Keys page: one OpenAI key for both
            const response = await storeCustomerVendorApiKey(token, { aiVendor: vendor, apiKey })
            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
            }
            return {
                success: response.apiKeyStatus.updateSuccessful,
                message: response.apiKeyStatus.detail || response.apiKeyStatus.status,
            }
        }

        const response = await storeEmbeddingKey(token, vendor as EmbeddingVendor, apiKey)
        if (response.keyStatus.updateSuccessful) {
            setVoyageStatus(response.keyStatus)
        }
        return {
            success: !!response.keyStatus.updateSuccessful,
            message: response.keyStatus.detail || response.keyStatus.status,
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.embeddingKeysSettings.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.embeddingKeysSettings.subtitle')}</p>
            </div>
            <div className={styles.form}>
                <VendorApiKeysManager
                    rows={rows}
                    onSaveKey={handleSaveKey}
                    strings={{
                        keySetPill: t('settingsPage.aiSettings.keySetPill'),
                        keyNotSetPill: t('settingsPage.aiSettings.keyNotSetPill'),
                        keyHint: t('settingsPage.aiSettings.apiKeyHint'),
                        keyPlaceholder: 'sk-... / pa-...',
                        keyReplacePlaceholder: t('settingsPage.aiSettings.overwriteApiKey'),
                        saveKey: t('settingsPage.aiSettings.save'),
                        saving: t('settingsPage.aiSettings.savingLabel'),
                        keyEmpty: t('settingsPage.aiSettings.enterValidApiKeyToast'),
                    }}
                    data-testid="embedding-keys"
                />
            </div>
        </div>
    )
}
