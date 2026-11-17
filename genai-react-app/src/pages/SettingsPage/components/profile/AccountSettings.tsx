import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputTextWithHint, PillButton, SettingsCard } from '@genflowly/component-library'
import { useAuth } from '../../../../context/AuthContext'
import { useToast } from '../../../../context/ToastContext'
import { updateUsername } from '../../../../services/userService'
import { useProfile } from '../../../../hooks/queries/useProfile'
import { SettingsFrame } from '../SettingsFrame'
import { useSettingsShell } from '../../SettingsShellContext'
import styles from './ProfilePages.module.scss'

function initials(name: string | null | undefined): string {
    return (name || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()
}

/** Profile › Account: who you sign in as, and your username. */
export function AccountSettings(): React.ReactElement {
    const { t } = useTranslation()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    const { narrow } = useSettingsShell()
    const { data: profile, isLoading } = useProfile()
    const [usernameInput, setUsernameInput] = useState('')
    const [saving, setSaving] = useState(false)

    // Seed once per distinct server value, so a background refetch returning
    // the same username never overwrites what the user is typing.
    const seeded = useRef<string | null>(null)
    useEffect(() => {
        if (!profile || seeded.current === profile.username) return
        seeded.current = profile.username ?? ''
        setUsernameInput(profile.username || '')
    }, [profile])

    const saveUsername = async () => {
        if (!usernameInput.trim() || usernameInput === profile?.username) return
        setSaving(true)
        try {
            await updateUsername(await getAccessTokenSilently(), usernameInput)
            showToast(t('settingsPage.profileSettings.usernameUpdatedMessage'))
        } catch (error: any) {
            showToast(error?.message || t('settingsPage.profileSettings.usernameUpdateFailedMessage'))
            setUsernameInput(profile?.username || '')
        } finally {
            setSaving(false)
        }
    }

    const knowledge = [
        { title: t('settingsPage.account.sourceTitle'), text: t('settingsPage.account.sourceText') },
        { title: t('settingsPage.account.usernameTitle'), text: t('settingsPage.account.usernameText') },
    ]

    return (
        <SettingsFrame page="account" knowledge={knowledge}>
            {!profile ? (
                <p className={styles.note}>
                    {isLoading ? t('settingsPage.profileSettings.loadingProfile') : t('settingsPage.profileSettings.loadProfileFailed')}
                </p>
            ) : (
                <>
                    <SettingsCard title={t('settingsPage.account.personalDetails')}>
                        <div className={styles.person}>
                            {profile.picture ? (
                                <img src={profile.picture} alt="" className={styles.avatar} />
                            ) : (
                                <span className={styles.avatar} aria-hidden="true">{initials(profile.name)}</span>
                            )}
                            <span className={styles.personText}>
                                <strong>{profile.name || t('settingsPage.profileSettings.noName')}</strong>
                                <span>{profile.email || t('settingsPage.profileSettings.noEmail')}</span>
                            </span>
                        </div>
                    </SettingsCard>
                    <SettingsCard title={t('settingsPage.account.usernameCard')}>
                        <div className={styles.fieldRow}>
                            <InputTextWithHint
                                hint={t('settingsPage.account.usernameLabel')}
                                value={usernameInput}
                                onChange={event => setUsernameInput(event.target.value)}
                                placeholder={t('settingsPage.profileSettings.usernamePlaceholder')}
                                layout={narrow ? 'stacked' : 'inline'}
                                className={styles.field}
                                data-testid="username-input"
                            />
                            <PillButton
                                label={saving ? t('settingsPage.account.saving') : t('settingsPage.account.updateUsername')}
                                onClick={saveUsername}
                                disabled={saving || usernameInput === profile.username || usernameInput.trim() === ''}
                                size={narrow ? 'lg' : 'md'}
                                data-testid="update-username"
                            />
                        </div>
                    </SettingsCard>
                </>
            )}
        </SettingsFrame>
    )
}
