import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../context/AuthContext';
import { PillButton } from '@genflowly/component-library';
import { updateUsername, updateDiscoverability } from '../../../services/userService';
import { useProfile } from '../../../hooks/queries/useProfile';
import { DeleteDataSettings } from './DeleteDataSettings';
import styles from './ProfileSettings.module.scss';

export function ProfileSettings(): React.ReactElement {
    const { t } = useTranslation();
    const { getAccessTokenSilently } = useAuth();
    const { data: profile, isLoading } = useProfile();
    const [usernameInput, setUsernameInput] = useState('');
    const [isDiscoverable, setIsDiscoverable] = useState(false);

    const [isSavingUsername, setIsSavingUsername] = useState(false);
    const [isSavingDiscoverability, setIsSavingDiscoverability] = useState(false);

    const [message, setMessage] = useState<{text: string, type: 'success' | 'error'} | null>(null);

    // Seed the editable fields from the profile once per distinct server
    // content — a background revalidation returning the same values must not
    // clobber in-progress typing.
    const seededRef = useRef<string | null>(null);
    useEffect(() => {
        if (!profile) return;
        const signature = JSON.stringify([profile.username, profile.isDiscoverable]);
        if (seededRef.current === signature) return;
        seededRef.current = signature;
        setUsernameInput(profile.username || '');
        setIsDiscoverable(profile.isDiscoverable);
    }, [profile]);

    const handleSaveUsername = async () => {
        if (!usernameInput || usernameInput === profile?.username) return;

        setIsSavingUsername(true);
        setMessage(null);
        try {
            const token = await getAccessTokenSilently();
            await updateUsername(token, usernameInput);
            setMessage({ text: t('settingsPage.profileSettings.usernameUpdatedMessage'), type: 'success' });
        } catch (err: any) {
            setMessage({ text: err.message || t('settingsPage.profileSettings.usernameUpdateFailedMessage'), type: 'error' });
            // Revert input on error
            setUsernameInput(profile?.username || '');
        } finally {
            setIsSavingUsername(false);
        }
    };

    const handleToggleDiscoverability = async (checked: boolean) => {
        setIsDiscoverable(checked);
        setIsSavingDiscoverability(true);
        setMessage(null);
        try {
            const token = await getAccessTokenSilently();
            const success = await updateDiscoverability(token, checked);
            if (!success) {
                throw new Error(t('settingsPage.profileSettings.discoverabilityUpdateFailedMessage'));
            }
        } catch (err: any) {
            setMessage({ text: err.message || t('settingsPage.profileSettings.discoverabilityUpdateFailedMessage'), type: 'error' });
            setIsDiscoverable(!checked); // Revert
        } finally {
            setIsSavingDiscoverability(false);
        }
    };

    if (isLoading && !profile) {
        return <div className={styles.card}>{t('settingsPage.profileSettings.loadingProfile')}</div>;
    }

    if (!profile) {
        return <div className={styles.card}>{t('settingsPage.profileSettings.loadProfileFailed')}</div>;
    }

    return (
        <div className={styles.container}>
            <div className={styles.form}>
                
                {message && (
                    <div className={`${styles.message} ${styles[message.type]}`}>
                        {message.text}
                    </div>
                )}
                
                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>{t('settingsPage.profileSettings.personalDetails')}</h3>
                    <div className={styles.profileInfo}>
                        {profile.picture ? (
                            <img src={profile.picture} alt={t('settingsPage.profileSettings.profilePictureAlt')} className={styles.profilePic} />
                        ) : (
                            <div className={styles.profilePic} style={{ backgroundColor: '#e2e8f0' }} />
                        )}
                        <div className={styles.profileDetails}>
                            <strong>{profile.name || t('settingsPage.profileSettings.noName')}</strong>
                            <span>{profile.email || t('settingsPage.profileSettings.noEmail')}</span>
                        </div>
                    </div>
                </div>

                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>{t('settingsPage.profileSettings.usernameSection')}</h3>
                    <div className={styles.inputGroup}>
                        <label className={styles.inputLabel}>{t('settingsPage.profileSettings.yourUsername')}</label>
                        <input
                            type="text"
                            value={usernameInput}
                            onChange={(e) => setUsernameInput(e.target.value)}
                            placeholder={t('settingsPage.profileSettings.usernamePlaceholder')}
                        />
                    </div>
                    <div className={styles.actions}>
                        <PillButton
                            label={isSavingUsername ? t('settingsPage.profileSettings.savingLabel') : t('settingsPage.profileSettings.updateUsername')}
                            variant="primary" 
                            onClick={handleSaveUsername} 
                            disabled={isSavingUsername || usernameInput === profile.username || usernameInput.trim() === ''}
                        />
                    </div>
                </div>

                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>{t('settingsPage.profileSettings.privacy')}</h3>
                    <div className={styles.toggleGroup}>
                        <div className={styles.toggleLabel}>
                            <strong>{t('settingsPage.profileSettings.discoverable')}</strong>
                            <span>{t('settingsPage.profileSettings.discoverableDescription')}</span>
                        </div>
                        <input 
                            type="checkbox"
                            checked={isDiscoverable}
                            onChange={(e) => handleToggleDiscoverability(e.target.checked)}
                            disabled={isSavingDiscoverability}
                        />
                    </div>
                </div>

                <DeleteDataSettings />
            </div>
        </div>
    );
};
