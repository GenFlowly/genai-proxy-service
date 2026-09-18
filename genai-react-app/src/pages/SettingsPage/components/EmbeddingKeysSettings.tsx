import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { AIVendor } from '../../../constants/vendors'
import { APIKeyStatus } from '../../../models/storeCustomerVendorAPIKeys.models'
import { storeCustomerVendorApiKey } from '../../../services/storeCustomerVendorApiKeysService'
import {
    EmbeddingKeyStatus,
    EmbeddingVendor,
    EmbeddingVendorModels,
    getEmbeddingKeys,
    getEmbeddingModels,
    storeEmbeddingKey,
} from '../../../services/embeddingKeysService'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { useToast } from '../../../context/ToastContext'
import { ICONS } from '../../../constants/icons'
import {
    InputSelectWithHint,
    PillButton,
    VendorApiKeysManager,
    VendorApiKeyRowData,
} from '@genflowly/component-library'
import { OpenAIBrandName } from '../../../components/common/BrandName/BrandName'
import styles from './EmbeddingKeysSettings.module.scss'

/** Data categories that can each carry their own default embedding model. */
type EmbeddingCategory = 'conversations' | 'notes'

interface CategorySelection {
    vendor: string
    model: string
}

const CATEGORIES: EmbeddingCategory[] = ['conversations', 'notes']

/** Infer the owning vendor from the model's naming convention. */
function vendorForModel(model: string): string {
    if (model.startsWith('voyage')) return EmbeddingVendor.VOYAGE
    if (model.startsWith('text-embedding')) return EmbeddingVendor.OPENAI
    return ''
}

/**
 * Bring-your-own API keys for the embedding models that index and search the
 * customer's data. The OpenAI key is the same key as on the Model API Keys
 * page (one key serves generation and embeddings), so it reads and writes the
 * shared vendor-key state; Voyage is embedding-only and has its own key.
 * Below the keys, per-category default embedding models (conversations,
 * notes) are picked vendor-first, then model.
 */
export function EmbeddingKeysSettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        isAuthenticated,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        updateVendorApiKeyStatus,
        aiConfigPreferences,
    } = useAuth()
    const { showToast } = useToast()

    const [voyageStatus, setVoyageStatus] = useState<EmbeddingKeyStatus | null>(null)
    const [vendorModels, setVendorModels] = useState<EmbeddingVendorModels[]>([])
    const [selections, setSelections] = useState<Record<EmbeddingCategory, CategorySelection>>({
        conversations: { vendor: '', model: '' },
        notes: { vendor: '', model: '' },
    })
    const [savingModel, setSavingModel] = useState(false)

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

    // Models are fetched with the customer's stored keys — providers without
    // a saved key come back absent, so the dropdown only offers usable models.
    const loadModels = useCallback(async () => {
        if (!isAuthenticated || !customerId) return
        try {
            const token = await getAccessTokenSilently()
            const response = await getEmbeddingModels(token)
            setVendorModels(response.vendorModels)
        } catch (err) {
            console.error('EmbeddingKeysSettings: failed to fetch embedding models', err)
        }
    }, [isAuthenticated, customerId, getAccessTokenSilently])

    useEffect(() => {
        void loadStatuses()
        void loadModels()
    }, [loadStatuses, loadModels])

    // Prefill from the customer's saved preferences; the per-category
    // preference wins, the legacy single embeddingModel is the fallback.
    useEffect(() => {
        const conversations =
            aiConfigPreferences?.embeddingModelConversations ?? aiConfigPreferences?.embeddingModel ?? ''
        const notes = aiConfigPreferences?.embeddingModelNotes ?? aiConfigPreferences?.embeddingModel ?? ''
        setSelections({
            conversations: { vendor: vendorForModel(conversations), model: conversations },
            notes: { vendor: vendorForModel(notes), model: notes },
        })
    }, [aiConfigPreferences])

    // OpenAI state lives in the shared vendor-key list, so a key stored on
    // the Model API Keys page shows as set here (and vice versa)
    const openAiVendorStatus = aiVendorAPIKeyStatusList.find(s => s.aiVendor === AIVendor.OPENAI)
    const openAiKeySet =
        openAiVendorStatus?.status === APIKeyStatus.VALID || !!openAiVendorStatus?.isAPIKeyValid

    const rows: VendorApiKeyRowData[] = useMemo(() => ([
        {
            vendor: EmbeddingVendor.OPENAI,
            label: <OpenAIBrandName className={styles.vendorBrand} />,
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
            // Same endpoint as the Model API Keys page: one OpenAI key for both
            const response = await storeCustomerVendorApiKey(token, { aiVendor: vendor, apiKey })
            if (response.apiKeyStatus.updateSuccessful) {
                updateVendorApiKeyStatus(response.apiKeyStatus)
            }
            return {
                success: response.apiKeyStatus.updateSuccessful,
                message: response.apiKeyStatus.status,
            }
        }

        const response = await storeEmbeddingKey(token, vendor as EmbeddingVendor, apiKey)
        if (response.keyStatus.updateSuccessful) {
            setVoyageStatus(response.keyStatus)
            // A newly stored key unlocks that provider's models
            void loadModels()
        }
        return {
            success: !!response.keyStatus.updateSuccessful,
            message: response.keyStatus.status,
        }
    }

    const vendorOptions = useMemo(() => (
        vendorModels.map(vm => ({
            label: vm.vendor === EmbeddingVendor.VOYAGE
                ? t('settingsPage.embeddingKeysSettings.voyageLabel')
                : 'OpenAI',
            value: vm.vendor,
        }))
    ), [vendorModels, t])

    const modelOptionsForVendor = (vendor: string) => (
        (vendorModels.find(vm => vm.vendor === vendor)?.models ?? [])
            .map(model => ({ label: model, value: model }))
    )

    const handleVendorChange = (category: EmbeddingCategory, vendor: string) => {
        // A new vendor invalidates the previous model choice
        setSelections(prev => ({ ...prev, [category]: { vendor, model: '' } }))
    }

    const handleModelChange = (category: EmbeddingCategory, model: string) => {
        setSelections(prev => ({ ...prev, [category]: { ...prev[category], model } }))
    }

    const handleSaveModels = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.aiSettings.loginFirstToast'))
            return
        }
        const prefs: { embeddingModelConversations?: string; embeddingModelNotes?: string } = {}
        if (selections.conversations.model) prefs.embeddingModelConversations = selections.conversations.model
        if (selections.notes.model) prefs.embeddingModelNotes = selections.notes.model
        if (!prefs.embeddingModelConversations && !prefs.embeddingModelNotes) return
        try {
            setSavingModel(true)
            const token = await getAccessTokenSilently()
            await saveAIConfigPreferences(token, { aiConfigPreferences: prefs })
            showToast(t('settingsPage.embeddingKeysSettings.modelSavedToast'))
        } catch (error: any) {
            console.error('Failed to save default embedding models:', error)
            showToast(error?.message || t('settingsPage.embeddingKeysSettings.modelSaveErrorToast'))
        } finally {
            setSavingModel(false)
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

                <div className={styles.field}>
                    <label className={styles.fieldLabel}>
                        {t('settingsPage.embeddingKeysSettings.defaultModelLabel')}
                    </label>
                    <p className={styles.emptyHint}>
                        {t('settingsPage.embeddingKeysSettings.defaultModelHint')}
                    </p>
                    {vendorOptions.length === 0 && (
                        <p className={styles.emptyHint}>
                            {t('settingsPage.embeddingKeysSettings.noModels')}
                        </p>
                    )}
                    {CATEGORIES.map(category => (
                        <div key={category} className={styles.categoryBlock}>
                            <label className={styles.fieldLabel}>
                                {t(`settingsPage.embeddingKeysSettings.category_${category}`)}
                            </label>
                            <div className={styles.categoryRow}>
                                <InputSelectWithHint
                                    hint={t('settingsPage.embeddingKeysSettings.vendorHint')}
                                    placeholder={t('settingsPage.embeddingKeysSettings.vendorPlaceholder')}
                                    value={selections[category].vendor}
                                    onChange={(val: string) => handleVendorChange(category, val)}
                                    options={vendorOptions}
                                    data-testid={`embedding-vendor-select-${category}`}
                                />
                                <InputSelectWithHint
                                    hint={t('settingsPage.embeddingKeysSettings.modelHint')}
                                    placeholder={t('settingsPage.embeddingKeysSettings.modelPlaceholder')}
                                    value={selections[category].model}
                                    onChange={(val: string) => handleModelChange(category, val)}
                                    options={modelOptionsForVendor(selections[category].vendor)}
                                    data-testid={`embedding-model-select-${category}`}
                                />
                            </div>
                        </div>
                    ))}
                    <div className={styles.footer}>
                        <PillButton
                            onClick={handleSaveModels}
                            label={savingModel
                                ? t('settingsPage.aiSettings.savingLabel')
                                : t('settingsPage.aiSettings.save')}
                            icon={ICONS.SAVE_ICON}
                            disabled={savingModel
                                || (!selections.conversations.model && !selections.notes.model)}
                            data-testid="save-default-embedding-model"
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}
