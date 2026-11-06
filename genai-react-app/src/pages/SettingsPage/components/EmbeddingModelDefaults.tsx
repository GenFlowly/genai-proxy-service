import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputSelectWithHint, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import {
    EmbeddingVendor,
} from '../../../services/embeddingKeysService'
import { useEmbeddingModels } from '../../../hooks/queries/useEmbeddingModels'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { useVendorDisplayNames } from '../../../hooks/useVendorDisplayNames'
import { ICONS } from '../../../constants/icons'
import styles from './EmbeddingModelDefaults.module.scss'

/**
 * Data categories that can each carry their own default embedding model. No
 * app saves notes any more, so only conversations are offered; a stored
 * notes default is left as it is.
 */
type EmbeddingCategory = 'conversations'

interface CategorySelection {
    vendor: string
    model: string
}

const CATEGORIES: EmbeddingCategory[] = ['conversations']

/** Infer the owning vendor from the model's naming convention. */
function vendorForModel(model: string): string {
    if (model.startsWith('voyage')) return EmbeddingVendor.VOYAGE
    if (model.startsWith('text-embedding')) return EmbeddingVendor.OPENAI
    return ''
}

/**
 * Per-category default embedding models (conversations), picked
 * vendor-first then model. Only vendors with a stored embedding API key
 * (managed on the Embedding Model API Keys page) offer models.
 */
export function EmbeddingModelDefaults(): React.ReactElement {
    const { t } = useTranslation()
    const { customerId, isAuthenticated, getAccessTokenSilently, aiConfigPreferences } = useAuth()
    const { showToast } = useToast()
    const vendorDisplayName = useVendorDisplayNames()

    const [selections, setSelections] = useState<Record<EmbeddingCategory, CategorySelection>>({
        conversations: { vendor: '', model: '' },
    })
    const [saving, setSaving] = useState(false)

    // Models are fetched with the customer's stored keys — providers without
    // a saved key come back absent, so the dropdown only offers usable models.
    // The last known list renders immediately (placeholder data) while the
    // fetch (which can wait on a server-side probe) revalidates it.
    const { data: embeddingModelsData } = useEmbeddingModels()
    const vendorModels = useMemo(() => embeddingModelsData?.vendorModels ?? [], [embeddingModelsData])

    // Prefill from the customer's saved preferences; the per-category
    // preference wins, the legacy single embeddingModel is the fallback.
    useEffect(() => {
        const conversations =
            aiConfigPreferences?.embeddingModelConversations ?? aiConfigPreferences?.embeddingModel ?? ''
        setSelections({
            conversations: { vendor: vendorForModel(conversations), model: conversations },
        })
    }, [aiConfigPreferences])

    const vendorOptions = useMemo(() => (
        vendorModels.map(vm => ({
            label: vm.vendor === EmbeddingVendor.VOYAGE
                ? t('settingsPage.embeddingDefaults.voyageLabel')
                : vendorDisplayName(vm.vendor),
            value: vm.vendor,
        }))
    ), [vendorModels, t, vendorDisplayName])

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

    const handleSave = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.embeddingDefaults.loginFirstToast'))
            return
        }
        if (!selections.conversations.model) return
        const prefs = { embeddingModelConversations: selections.conversations.model }
        try {
            setSaving(true)
            const token = await getAccessTokenSilently()
            await saveAIConfigPreferences(token, { aiConfigPreferences: prefs })
            showToast(t('settingsPage.embeddingDefaults.savedToast'))
        } catch (error: any) {
            console.error('Failed to save default embedding models:', error)
            showToast(error?.message || t('settingsPage.embeddingDefaults.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.embeddingDefaults.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.embeddingDefaults.subtitle')}</p>
            </div>
            <div className={styles.form}>
                {vendorOptions.length === 0 && (
                    <p className={styles.emptyHint}>
                        {t('settingsPage.embeddingDefaults.noModels')}
                    </p>
                )}
                {CATEGORIES.map(category => (
                    <div key={category} className={styles.categoryBlock}>
                        <label className={styles.fieldLabel}>
                            {t(`settingsPage.embeddingDefaults.category_${category}`)}
                        </label>
                        <div className={styles.categoryRow}>
                            <InputSelectWithHint
                                hint={t('settingsPage.embeddingDefaults.vendorHint')}
                                placeholder={t('settingsPage.embeddingDefaults.vendorPlaceholder')}
                                value={selections[category].vendor}
                                onChange={(val: string) => handleVendorChange(category, val)}
                                options={vendorOptions}
                                data-testid={`embedding-vendor-select-${category}`}
                            />
                            <InputSelectWithHint
                                hint={t('settingsPage.embeddingDefaults.modelHint')}
                                placeholder={t('settingsPage.embeddingDefaults.modelPlaceholder')}
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
                        onClick={handleSave}
                        label={saving
                            ? t('settingsPage.embeddingDefaults.saving')
                            : t('settingsPage.embeddingDefaults.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={saving || !selections.conversations.model}
                        data-testid="save-default-embedding-model"
                    />
                </div>
            </div>
        </div>
    )
}
