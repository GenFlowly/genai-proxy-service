import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SettingsCard, SettingsRow, ToggleRow } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { useToast } from '../../../../context/ToastContext'
import { updateDiscoverability } from '../../../../services/userService'
import { useProfile } from '../../../../hooks/queries/useProfile'
import { useHasOwnKeys } from '../../../../hooks/useHasOwnKeys'
import { SettingsFrame } from '../SettingsFrame'
import styles from './ProfilePages.module.scss'

/**
 * Profile › Privacy: whether people can find you, and plainly how replies
 * work — what is sent where so the assistant can answer.
 */
export function PrivacySettings(): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently, aiDataConsentAt } = useAuth()
    const { showToast } = useToast()
    const hasOwnKeys = useHasOwnKeys()
    const { data: profile } = useProfile()
    const [discoverable, setDiscoverable] = useState(false)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (profile) setDiscoverable(profile.isDiscoverable)
    }, [profile])

    const toggleDiscoverable = async (checked: boolean) => {
        setDiscoverable(checked)
        setSaving(true)
        try {
            const saved = await updateDiscoverability(await getAccessTokenSilently(), checked)
            if (!saved) throw new Error(t('settingsPage.profileSettings.discoverabilityUpdateFailedMessage'))
        } catch (error: any) {
            showToast(error?.message || t('settingsPage.profileSettings.discoverabilityUpdateFailedMessage'))
            setDiscoverable(!checked)
        } finally {
            setSaving(false)
        }
    }

    const agreedDate = aiDataConsentAt ? new Date(aiDataConsentAt).toLocaleDateString() : null
    const knowledge = [
        { title: t('settingsPage.privacy.discoverableTitle'), text: t('settingsPage.privacy.discoverableText') },
        {
            title: t('settingsPage.privacy.repliesTitle'),
            text: [t('settingsPage.privacy.repliesText'), agreedDate && t('settingsPage.privacy.agreedOnSentence', { date: agreedDate })]
                .filter(Boolean).join(' '),
        },
    ]

    return (
        <SettingsFrame page="privacy" knowledge={knowledge}>
            <SettingsCard title={t('settingsPage.privacy.visibility')}>
                <ToggleRow
                    label={t('settingsPage.privacy.discoverable')}
                    checked={discoverable}
                    onChange={toggleDiscoverable}
                    disabled={saving || !profile}
                    data-testid="discoverable-switch"
                />
            </SettingsCard>
            <SettingsCard
                title={t('settingsPage.privacy.repliesTitle')}
                hint={agreedDate ? t('settingsPage.privacy.agreedOn', { date: agreedDate }) : undefined}
                data-testid="ai-data-sharing"
            >
                <SettingsRow label={t('settingsPage.privacy.modelsTitle')} description={t('settingsPage.privacy.modelsText')} />
                <SettingsRow label={t('settingsPage.privacy.memoryTitle')} description={t('settingsPage.privacy.memoryText')} />
                <SettingsRow label={t('settingsPage.privacy.toolsTitle')} description={t('settingsPage.privacy.toolsText')} />
                <SettingsRow
                    label={t('settingsPage.privacy.ownTerms')}
                    stackOnNarrow
                    action={
                        <span className={styles.links}>
                            {hasOwnKeys && (
                                <Link to="/settings/byok/llm-keys" className={styles.link}>{t('settingsPage.privacy.manageServices')}</Link>
                            )}
                            <Link to="/privacy-policy" className={styles.link}>{t('settingsPage.privacy.privacyPolicy')}</Link>
                        </span>
                    }
                />
            </SettingsCard>
        </SettingsFrame>
    )
}
