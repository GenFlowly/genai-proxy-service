import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
    InputSelectWithHint,
    InputTextWithHint,
    PillButton,
    SettingsCard,
    SettingsRow,
    StatusPill,
    TypedConfirmDialog,
} from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { EmbeddingVendor } from '../../../services/embeddingKeysService'
import { useEmbeddingModels } from '../../../hooks/queries/useEmbeddingModels'
import { EmbeddingModelLockedError, saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { getAiPreferences, mergeAiPreferences, subscribeAiPreferences } from '../../../stores/aiPreferencesStore'
import { useEmbeddingVendorName } from '../../../hooks/useEmbeddingVendorName'
import { useHasOwnKeys } from '../../../hooks/useHasOwnKeys'
import {
    PLATFORM_EMBEDDING_MODEL,
    chosenEmbeddingModel,
    embeddingVendorFor,
    isEmbeddingModelUnusable,
} from '../../../utils/embeddingModel'
import { SettingsFrame } from './SettingsFrame'
import { useSettingsShell } from '../SettingsShellContext'
import styles from './EmbeddingModelDefaults.module.scss'

const LOCK_WORD = 'LOCK'
const VENDORS = [EmbeddingVendor.OPENAI, EmbeddingVendor.VOYAGE]

type PageState = 'notChosen' | 'locked' | 'unavailable'

/**
 * Defaults › Embedding models: the one model that indexes and searches the
 * customer's data. It is chosen once, confirmed by typing LOCK, and read-only
 * after that. A locked model the key can no longer use may be chosen again;
 * the server allows exactly that case and answers 409 with the locked model
 * for any other change.
 */
export function EmbeddingModelDefaults(): React.ReactElement {
    const { t } = useTranslation()
    const { isAuthenticated, getAccessTokenSilently, resyncAccount } = useAuth()
    const { showToast } = useToast()
    const { narrow } = useSettingsShell()
    const hasOwnKeys = useHasOwnKeys()
    const vendorLabel = useEmbeddingVendorName()
    const preferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const { data: embeddingModelsData } = useEmbeddingModels()
    const vendorModels = useMemo(() => embeddingModelsData?.vendorModels ?? [], [embeddingModelsData])

    const [vendor, setVendor] = useState('')
    const [model, setModel] = useState('')
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [saving, setSaving] = useState(false)

    const chosen = chosenEmbeddingModel(preferences)
    const state: PageState = !chosen
        ? 'notChosen'
        : embeddingModelsData && isEmbeddingModelUnusable(chosen, vendorModels) ? 'unavailable' : 'locked'

    const vendorOptions = vendorModels.map(entry => ({ label: vendorLabel(entry.vendor), value: entry.vendor }))
    const modelOptions = (vendorModels.find(entry => entry.vendor === vendor)?.models ?? [])
        .map(name => ({ label: name, value: name }))

    const lockModel = async () => {
        if (!isAuthenticated) {
            showToast(t('settingsPage.embeddingDefaults.loginFirstToast'))
            return
        }
        setSaving(true)
        try {
            const token = await getAccessTokenSilently()
            await saveAIConfigPreferences(token, { aiConfigPreferences: { embeddingModelConversations: model } })
            mergeAiPreferences({ embeddingModel: model, embeddingModelNotes: model })
            resyncAccount()
            setConfirmOpen(false)
            showToast(t('settingsPage.embeddingModels.lockedToast', { model }))
        } catch (error) {
            if (error instanceof EmbeddingModelLockedError) {
                const locked = error.lockedModel
                mergeAiPreferences({ embeddingModel: locked, embeddingModelConversations: locked, embeddingModelNotes: locked })
                setConfirmOpen(false)
                showToast(t('settingsPage.embeddingModels.alreadyLockedToast', { model: locked }))
            } else {
                console.error('Failed to save the embedding model:', error)
                showToast(error instanceof Error && error.message ? error.message : t('settingsPage.embeddingDefaults.saveErrorToast'))
            }
        } finally {
            setSaving(false)
        }
    }

    const statusText = {
        notChosen: t('settingsPage.embeddingModels.notChosen'),
        locked: t('settingsPage.embeddingModels.locked'),
        unavailable: t('settingsPage.embeddingModels.unavailable'),
    }[state]
    const statusPill = (
        <StatusPill kind={{ notChosen: 'unset', locked: 'locked', unavailable: 'warn' }[state] as 'unset' | 'locked' | 'warn'}>
            {statusText}
        </StatusPill>
    )
    const chosenAt = preferences?.embeddingModelChosenAt
    const hint = {
        notChosen: t('settingsPage.embeddingModels.inUse', { model: PLATFORM_EMBEDDING_MODEL }),
        locked: chosenAt ? t('settingsPage.embeddingModels.chosenOn', { date: new Date(chosenAt).toLocaleDateString() }) : undefined,
        unavailable: t('settingsPage.embeddingModels.unavailableHint', { model: chosen }),
    }[state]
    const knowledge = [
        { title: t('settingsPage.embeddingModels.doesTitle'), text: t('settingsPage.embeddingModels.doesText') },
        { title: t('settingsPage.embeddingModels.onceTitle'), text: t('settingsPage.embeddingModels.onceText') },
    ]
    const layout = narrow ? 'stacked' : 'inline'
    const lockedVendor = embeddingVendorFor(chosen)

    return (
        <SettingsFrame page="defaults-embedding-models" knowledge={knowledge} status={statusPill} statusText={statusText}>
            <SettingsCard title={t('settingsPage.embeddingModels.card')} pills={statusPill} hint={hint} data-testid="embedding-model-card">
                {state === 'locked' ? (
                    <div className={styles.fields}>
                        <InputTextWithHint
                            hint={t('settingsPage.embeddingDefaults.vendorHint')}
                            value={lockedVendor ? vendorLabel(lockedVendor) : ''}
                            readOnly
                            layout={layout}
                            data-testid="embedding-model-locked-vendor"
                        />
                        <InputTextWithHint
                            hint={t('settingsPage.embeddingDefaults.modelHint')}
                            value={chosen ?? ''}
                            readOnly
                            layout={layout}
                            data-testid="embedding-model-locked-model"
                        />
                    </div>
                ) : (
                    <>
                        <div className={styles.fields}>
                            <InputSelectWithHint
                                hint={t('settingsPage.embeddingDefaults.vendorHint')}
                                placeholder={t('settingsPage.embeddingDefaults.vendorPlaceholder')}
                                value={vendor}
                                onChange={(value: string) => { setVendor(value); setModel('') }}
                                options={vendorOptions}
                                layout={layout}
                                data-testid="embedding-vendor-select-conversations"
                            />
                            <InputSelectWithHint
                                hint={t('settingsPage.embeddingDefaults.modelHint')}
                                placeholder={t('settingsPage.embeddingDefaults.modelPlaceholder')}
                                value={model}
                                onChange={(value: string) => setModel(value)}
                                options={modelOptions}
                                layout={layout}
                                data-testid="embedding-model-select-conversations"
                            />
                        </div>
                        {vendorOptions.length === 0 && embeddingModelsData && (
                            <p className={styles.note}>{t('settingsPage.embeddingDefaults.noModels')}</p>
                        )}
                        <div className={styles.footer}>
                            <PillButton
                                label={t('settingsPage.embeddingModels.chooseAndLock')}
                                onClick={() => setConfirmOpen(true)}
                                disabled={!model || saving}
                                size={narrow ? 'lg' : 'md'}
                                data-testid="save-default-embedding-model"
                            />
                            <span className={styles.note}>{t('settingsPage.embeddingModels.permanent')}</span>
                        </div>
                        {hasOwnKeys && (
                            <SettingsRow
                                label={t('settingsPage.embeddingModels.ready')}
                                stackOnNarrow={false}
                                data-testid="embedding-model-readiness"
                                action={
                                    VENDORS.some(id => !vendorModels.some(entry => entry.vendor === id)) && (
                                        <Link to="/settings/byok/embedding-keys" className={styles.link}>
                                            {t('settingsPage.searchIndex.setUp')}
                                        </Link>
                                    )
                                }
                            >
                                <span className={styles.pills}>
                                    {VENDORS.map(id => {
                                        const ready = vendorModels.some(entry => entry.vendor === id)
                                        return (
                                            <StatusPill key={id} kind={ready ? 'ok' : 'unset'}>
                                                {t(ready ? 'settingsPage.embeddingModels.vendorReady' : 'settingsPage.embeddingModels.vendorNotSet', { vendor: vendorLabel(id) })}
                                            </StatusPill>
                                        )
                                    })}
                                </span>
                            </SettingsRow>
                        )}
                    </>
                )}
            </SettingsCard>

            <TypedConfirmDialog
                isOpen={confirmOpen}
                onClose={() => !saving && setConfirmOpen(false)}
                onConfirm={() => void lockModel()}
                title={t('settingsPage.embeddingModels.lockTitle', { model })}
                message={<p>{t('settingsPage.embeddingModels.lockText')}</p>}
                confirmWord={LOCK_WORD}
                inputLabel={t('settingsPage.embeddingModels.lockPrompt', { word: LOCK_WORD })}
                confirmLabel={saving ? t('settingsPage.embeddingDefaults.saving') : t('settingsPage.embeddingModels.lockButton')}
                cancelLabel={t('settingsPage.profileSettings.deleteData.cancel')}
                danger={false}
                busy={saving}
                data-testid="embedding-model-lock-dialog"
            />
        </SettingsFrame>
    )
}
