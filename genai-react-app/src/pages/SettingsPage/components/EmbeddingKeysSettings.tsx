import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import {
    EmbeddingKeyStatus,
    EmbeddingVendor,
    deleteEmbeddingKey,
    getEmbeddingKeys,
    storeEmbeddingKey,
} from '../../../services/embeddingKeysService'
import {
    StatusPill,
    VendorApiKeysManager,
    VendorApiKeyRowData,
} from '@genflowly/component-library'
import { VendorBrandName } from '../../../components/common/BrandName/BrandName'
import { chosenEmbeddingModel, embeddingVendorFor } from '../../../utils/embeddingModel'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'
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
 * The embedding model itself (one, chosen once) lives on Defaults › Embedding models.
 *
 * The optional Hugging Face token rides the same credential endpoints but is
 * rendered in its own manager: it is the only removable credential (the
 * OpenAI row doubles as the LLM key; Voyage backs stored preferences), and a
 * shared manager instance would put remove buttons on every row.
 */
export function EmbeddingKeysSettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        isAuthenticated,
        getAccessTokenSilently,
        updateVendorApiKeyStatus,
        aiConfigPreferences,
    } = useAuth()
    const { narrow } = useSettingsShell()
    const chosenVendor = embeddingVendorFor(chosenEmbeddingModel(aiConfigPreferences))
    const usedPill = (vendor: EmbeddingVendor) => chosenVendor === vendor
        ? <StatusPill>{t('settingsPage.embeddingKeys.usedPill')}</StatusPill>
        : undefined

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

    const rows: VendorApiKeyRowData[] = [
        {
            vendor: EmbeddingVendor.OPENAI,
            label: <VendorBrandName vendorId={EmbeddingVendor.OPENAI} className={styles.vendorBrand} />,
            keySet: keySet(statuses.find(s => s.vendor === EmbeddingVendor.OPENAI)),
            pills: usedPill(EmbeddingVendor.OPENAI),
            hint: t('settingsPage.embeddingKeys.sharedHint'),
        },
        {
            vendor: EmbeddingVendor.VOYAGE,
            label: t('settingsPage.embeddingKeysSettings.voyageLabel'),
            keySet: keySet(statuses.find(s => s.vendor === EmbeddingVendor.VOYAGE)),
            pills: usedPill(EmbeddingVendor.VOYAGE),
            keyPlaceholder: 'pa-…',
        },
    ]

    const hfRows: VendorApiKeyRowData[] = useMemo(() => ([
        {
            vendor: EmbeddingVendor.HUGGINGFACE,
            label: t('settingsPage.embeddingKeysSettings.huggingFaceLabel'),
            keySet: keySet(statuses.find(s => s.vendor === EmbeddingVendor.HUGGINGFACE)),
            hint: t('settingsPage.embeddingKeys.optionalHint'),
        },
    ]), [statuses, t])

    const vendorLabel = (vendor: EmbeddingVendor) => {
        switch (vendor) {
            case EmbeddingVendor.VOYAGE:
                return t('settingsPage.embeddingKeysSettings.voyageLabel')
            case EmbeddingVendor.HUGGINGFACE:
                return t('settingsPage.embeddingKeysSettings.huggingFaceLabel')
            default:
                return 'OpenAI'
        }
    }

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

    const handleDeleteKey = async (vendor: string) => {
        if (!isAuthenticated || !customerId) {
            throw new Error(t('settingsPage.aiSettings.loginFirstToast'))
        }
        const token = await getAccessTokenSilently()
        await deleteEmbeddingKey(token, vendor as EmbeddingVendor)
        setStatus({
            vendor: vendor as EmbeddingVendor,
            isAPIKeyValid: false,
            status: APIKeyStatus.NOT_SET,
        })
    }

    const problems = statuses.filter(s => s.detail)

    const setCount = rows.filter(row => row.keySet).length
    const statusText = t('settingsPage.llmKeys.setCount', { count: setCount })
    const knowledge = [
        { title: t('settingsPage.embeddingKeys.whatTitle'), text: t('settingsPage.embeddingKeys.whatText') },
        { title: t('settingsPage.embeddingKeys.hfTitle'), text: t('settingsPage.embeddingKeys.hfText') },
    ]

    return (
        <SettingsFrame
            page="embedding-keys"
            knowledge={knowledge}
            statusText={statusText}
            status={<StatusPill kind={setCount > 0 ? 'ok' : 'unset'}>{statusText}</StatusPill>}
        >
                <VendorApiKeysManager
                    rows={rows}
                    onSaveKey={handleSaveKey}
                    strings={{
                        keySetPill: t('settingsPage.aiSettings.keySetPill'),
                        keyNotSetPill: t('settingsPage.aiSettings.keyNotSetPill'),
                        keyHint: t('settingsPage.aiSettings.apiKeyHint'),
                        keyPlaceholder: t('settingsPage.llmKeys.enterKey'),
                        keyReplacePlaceholder: t('settingsPage.llmKeys.replaceKey'),
                        saveKey: t('settingsPage.aiSettings.save'),
                        saving: t('settingsPage.aiSettings.savingLabel'),
                        keyEmpty: t('settingsPage.aiSettings.enterValidApiKeyToast'),
                    }}
                    narrow={narrow}
                    data-testid="embedding-keys"
                />
                <VendorApiKeysManager
                    rows={hfRows}
                    onSaveKey={handleSaveKey}
                    onDeleteKey={handleDeleteKey}
                    strings={{
                        keySetPill: t('settingsPage.aiSettings.keySetPill'),
                        keyNotSetPill: t('settingsPage.aiSettings.keyNotSetPill'),
                        keyPlaceholder: 'hf_…',
                        keyHint: t('settingsPage.embeddingKeys.tokenHint'),
                        keyReplacePlaceholder: t('settingsPage.llmKeys.replaceKey'),
                        saveKey: t('settingsPage.aiSettings.save'),
                        removeKey: t('settingsPage.embeddingKeysSettings.removeKey'),
                        keyRemoved: t('settingsPage.embeddingKeysSettings.keyRemoved'),
                        saving: t('settingsPage.aiSettings.savingLabel'),
                        keyEmpty: t('settingsPage.aiSettings.enterValidApiKeyToast'),
                    }}
                    narrow={narrow}
                    data-testid="hf-token"
                />
                {problems.map(s => (
                    <p key={s.vendor} className={styles.keyProblem} data-testid={`embedding-key-problem-${s.vendor}`}>
                        {vendorLabel(s.vendor)}: {s.detail}
                    </p>
                ))}
        </SettingsFrame>
    )
}
