import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
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

const keySet = (status?: EmbeddingKeyStatus): boolean =>
    status?.status === APIKeyStatus.VALID || !!status?.isAPIKeyValid

/**
 * Bring-your-own API keys for the embedding models that index and search the
 * customer's data. The OpenAI key is the same key as on the LLM API Keys
 * page (one key serves generation and embeddings), so saving here writes the
 * shared vendor-key state; Voyage is embedding-only and has its own key.
 * Both pills read the embedding-keys endpoint, whose status is capability-
 * aware: a key the vendor rejects for embeddings (e.g. an OpenAI key without
 * embeddings permission) reports as not set, with the backend's detail
 * message shown below — even though the LLM page shows the same key as set.
 * The per-category default embedding models live on the Defaults page.
 */
export function EmbeddingKeysSettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        isAuthenticated,
        getAccessTokenSilently,
        updateVendorApiKeyStatus,
    } = useAuth()

    const [statuses, setStatuses] = useState<EmbeddingKeyStatus[]>([])

    const loadStatuses = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            const token = await getAccessTokenSilently()
            const response = await getEmbeddingKeys(token)
            setStatuses(response.statuses)
        } catch (err) {
            console.error('EmbeddingKeysSettings: failed to fetch key statuses', err)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        void loadStatuses()
    }, [loadStatuses])

    const setStatus = (status: EmbeddingKeyStatus) =>
        setStatuses(prev => [...prev.filter(s => s.vendor !== status.vendor), status])

    const rows: VendorApiKeyRowData[] = useMemo(() => ([
        {
            vendor: EmbeddingVendor.OPENAI,
            label: <VendorBrandName vendorId={EmbeddingVendor.OPENAI} className={styles.vendorBrand} />,
            keySet: keySet(statuses.find(s => s.vendor === EmbeddingVendor.OPENAI)),
        },
        {
            vendor: EmbeddingVendor.VOYAGE,
            label: t('settingsPage.embeddingKeysSettings.voyageLabel'),
            keySet: keySet(statuses.find(s => s.vendor === EmbeddingVendor.VOYAGE)),
        },
    ]), [statuses, t])

    const vendorLabel = (vendor: EmbeddingVendor) =>
        vendor === EmbeddingVendor.VOYAGE
            ? t('settingsPage.embeddingKeysSettings.voyageLabel')
            : 'OpenAI'

    const handleSaveKey = async (vendor: string, apiKey: string) => {
        if (!isAuthenticated || !customerId) {
            throw new Error(t('settingsPage.aiSettings.loginFirstToast'))
        }
        const token = await getAccessTokenSilently()

        if (vendor === EmbeddingVendor.OPENAI) {
            // Same endpoint as the LLM API Keys page: one OpenAI key for both.
            // The embedding-capability verdict lands asynchronously (the server
            // probes on save), so reflect the save result optimistically here;
            // the next status load reports capability.
            const response = await storeCustomerVendorApiKey(token, { aiVendor: vendor, apiKey })
            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
                setStatus({
                    vendor: EmbeddingVendor.OPENAI,
                    isAPIKeyValid: true,
                    status: APIKeyStatus.VALID,
                })
            }
            return {
                success: response.apiKeyStatus.updateSuccessful,
                message: response.apiKeyStatus.detail || response.apiKeyStatus.status,
            }
        }

        const response = await storeEmbeddingKey(token, vendor as EmbeddingVendor, apiKey)
        if (response.keyStatus.updateSuccessful) {
            setStatus(response.keyStatus)
        }
        return {
            success: !!response.keyStatus.updateSuccessful,
            message: response.keyStatus.detail || response.keyStatus.status,
        }
    }

    const problems = statuses.filter(s => s.detail)

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
                {problems.map(s => (
                    <p key={s.vendor} className={styles.keyProblem} data-testid={`embedding-key-problem-${s.vendor}`}>
                        {vendorLabel(s.vendor)}: {s.detail}
                    </p>
                ))}
            </div>
        </div>
    )
}
