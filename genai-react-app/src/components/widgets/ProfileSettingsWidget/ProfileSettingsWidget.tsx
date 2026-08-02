import React, { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import PillButton from '../../common/PillButton/PillButton';
import { getUserProfile, updateUsername, updateDiscoverability } from '../../../services/userService';
import { CustomerProfileResponse } from '../../../models/user.models';
import styles from './ProfileSettingsWidget.module.scss';

const ProfileSettingsWidget: React.FC = () => {
    const { getAccessTokenSilently } = useAuth0();
    const [profile, setProfile] = useState<CustomerProfileResponse | null>(null);
    const [usernameInput, setUsernameInput] = useState('');
    const [isDiscoverable, setIsDiscoverable] = useState(false);
    
    const [isLoading, setIsLoading] = useState(true);
    const [isSavingUsername, setIsSavingUsername] = useState(false);
    const [isSavingDiscoverability, setIsSavingDiscoverability] = useState(false);
    
    const [message, setMessage] = useState<{text: string, type: 'success' | 'error'} | null>(null);

    useEffect(() => {
        const loadProfile = async () => {
            try {
                const token = await getAccessTokenSilently();
                const data = await getUserProfile(token);
                if (data) {
                    setProfile(data);
                    setUsernameInput(data.username || '');
                    setIsDiscoverable(data.isDiscoverable);
                }
            } catch (err) {
                console.error("Failed to load profile", err);
            } finally {
                setIsLoading(false);
            }
        };
        
        loadProfile();
    }, [getAccessTokenSilently]);

    const handleSaveUsername = async () => {
        if (!usernameInput || usernameInput === profile?.username) return;
        
        setIsSavingUsername(true);
        setMessage(null);
        try {
            const token = await getAccessTokenSilently();
            await updateUsername(token, usernameInput);
            setProfile(prev => prev ? { ...prev, username: usernameInput } : null);
            setMessage({ text: 'Username updated successfully!', type: 'success' });
        } catch (err: any) {
            setMessage({ text: err.message || 'Failed to update username', type: 'error' });
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
            if (success) {
                setProfile(prev => prev ? { ...prev, isDiscoverable: checked } : null);
            } else {
                throw new Error("Failed to update discoverability");
            }
        } catch (err: any) {
            setMessage({ text: err.message || 'Failed to update discoverability', type: 'error' });
            setIsDiscoverable(!checked); // Revert
        } finally {
            setIsSavingDiscoverability(false);
        }
    };

    if (isLoading) {
        return <div className={styles.card}>Loading profile...</div>;
    }

    if (!profile) {
        return <div className={styles.card}>Failed to load profile data.</div>;
    }

    return (
        <div className={styles.card}>
            <h2 className={styles.title}>Profile Settings</h2>
            
            <div className={styles.form}>
                
                {message && (
                    <div className={`${styles.message} ${styles[message.type]}`}>
                        {message.text}
                    </div>
                )}
                
                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>Personal Details</h3>
                    <div className={styles.profileInfo}>
                        {profile.picture ? (
                            <img src={profile.picture} alt="Profile" className={styles.profilePic} />
                        ) : (
                            <div className={styles.profilePic} style={{ backgroundColor: '#e2e8f0' }} />
                        )}
                        <div className={styles.profileDetails}>
                            <strong>{profile.name || 'No Name'}</strong>
                            <span>{profile.email || 'No Email'}</span>
                        </div>
                    </div>
                </div>

                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>Username</h3>
                    <div className={styles.inputGroup}>
                        <label className={styles.inputLabel}>Your Username</label>
                        <input 
                            type="text" 
                            value={usernameInput}
                            onChange={(e) => setUsernameInput(e.target.value)}
                            placeholder="e.g. johndoe-1234"
                        />
                    </div>
                    <div className={styles.actions}>
                        <PillButton 
                            label={isSavingUsername ? "Saving..." : "Update Username"} 
                            variant="primary" 
                            onClick={handleSaveUsername} 
                            disabled={isSavingUsername || usernameInput === profile.username || usernameInput.trim() === ''}
                        />
                    </div>
                </div>

                <div className={styles.section}>
                    <h3 className={styles.sectionTitle}>Privacy</h3>
                    <div className={styles.toggleGroup}>
                        <div className={styles.toggleLabel}>
                            <strong>Discoverable</strong>
                            <span>Allow other users to search for you by your exact username when sharing instructions.</span>
                        </div>
                        <input 
                            type="checkbox"
                            checked={isDiscoverable}
                            onChange={(e) => handleToggleDiscoverability(e.target.checked)}
                            disabled={isSavingDiscoverability}
                        />
                    </div>
                </div>

            </div>
        </div>
    );
};

export default ProfileSettingsWidget;
