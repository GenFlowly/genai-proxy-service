import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputSelectWithHint, PillButton } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { saveAIConfigPreferences } from '../../../services/saveAIConfigService'
import { ICONS } from '../../../constants/icons'
import styles from './InstructionDefaultsSettings.module.scss'

type FallbackMode = 'preferred' | 'lastUsed'

/**
 * Lets a customer choose which instruction applies when they start a chat
 * without selecting one: their preferred instruction, or their last-used one.
 * Backed by AIConfigPreferences (preferredInstructionId / instructionFallbackMode).
 */
export function InstructionDefaultsSettings(): React.ReactElement {
    const { t } = useTranslation()
    const {
        customerId,
        isAuthenticated,
        getAccessTokenSilently,
        aiConfigPreferences,
        customerInstructions,
    } = useAuth()
    const { showToast } = useToast()

    const [mode, setMode] = useState<FallbackMode>('preferred')
    const [preferredInstructionId, setPreferredInstructionId] = useState('')
    const [saving, setSaving] = useState(false)

    // Prefill from the customer's saved preferences
    useEffect(() => {
        const savedMode = aiConfigPreferences?.instructionFallbackMode
        if (savedMode === 'lastUsed' || savedMode === 'preferred') setMode(savedMode)
        if (aiConfigPreferences?.preferredInstructionId) {
            setPreferredInstructionId(aiConfigPreferences.preferredInstructionId)
        }
    }, [aiConfigPreferences])

    const modeOptions = useMemo(() => ([
        { label: t('settingsPage.instructionDefaults.modePreferred'), value: 'preferred' },
        { label: t('settingsPage.instructionDefaults.modeLastUsed'), value: 'lastUsed' },
    ]), [t])

    const instructionOptions = useMemo(() => (
        (customerInstructions ?? []).map(i => ({
            label: i.name || (i.instruction.length > 50 ? `${i.instruction.slice(0, 50)}…` : i.instruction),
            value: i.id,
        }))
    ), [customerInstructions])

    const handleSave = async () => {
        if (!isAuthenticated || !customerId) {
            showToast(t('settingsPage.instructionDefaults.loginFirstToast'))
            return
        }
        try {
            setSaving(true)
            const token = await getAccessTokenSilently()
            const prefs: { instructionFallbackMode: string; preferredInstructionId?: string } = {
                instructionFallbackMode: mode,
            }
            if (mode === 'preferred' && preferredInstructionId) {
                prefs.preferredInstructionId = preferredInstructionId
            }
            await saveAIConfigPreferences(token, { aiConfigPreferences: prefs })
            showToast(t('settingsPage.instructionDefaults.savedToast'))
        } catch (error: any) {
            console.error('Failed to save instruction preferences:', error)
            showToast(error?.message || t('settingsPage.instructionDefaults.saveErrorToast'))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className={styles.container}>
            <div className={styles.headerBlock}>
                <h2 className={styles.title}>{t('settingsPage.instructionDefaults.title')}</h2>
                <p className={styles.subtitle}>{t('settingsPage.instructionDefaults.subtitle')}</p>
            </div>

            <div className={styles.form}>
                <div className={styles.field}>
                    <label className={styles.fieldLabel}>{t('settingsPage.instructionDefaults.modeLabel')}</label>
                    <InputSelectWithHint
                        hint={t('settingsPage.instructionDefaults.modeHint')}
                        value={mode}
                        onChange={(val: string) => setMode(val === 'lastUsed' ? 'lastUsed' : 'preferred')}
                        options={modeOptions}
                        data-testid="instruction-fallback-mode"
                    />
                </div>

                {mode === 'preferred' && (
                    <div className={styles.field}>
                        <label className={styles.fieldLabel}>{t('settingsPage.instructionDefaults.preferredLabel')}</label>
                        <InputSelectWithHint
                            hint={t('settingsPage.instructionDefaults.preferredHint')}
                            icon={ICONS.USER_ROLE}
                            placeholder={t('settingsPage.instructionDefaults.preferredPlaceholder')}
                            value={preferredInstructionId}
                            onChange={(val: string) => setPreferredInstructionId(val)}
                            options={instructionOptions}
                            data-testid="preferred-instruction-select"
                        />
                        {instructionOptions.length === 0 && (
                            <p className={styles.emptyHint}>{t('settingsPage.instructionDefaults.noInstructions')}</p>
                        )}
                    </div>
                )}

                <div className={styles.footer}>
                    <PillButton
                        onClick={handleSave}
                        label={saving ? t('settingsPage.instructionDefaults.saving') : t('settingsPage.instructionDefaults.save')}
                        icon={ICONS.SAVE_ICON}
                        disabled={saving}
                    />
                </div>
            </div>
        </div>
    )
}
