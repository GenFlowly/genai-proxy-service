import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth0 } from '@auth0/auth0-react';
import { Modal } from '@genflowly/component-library';
import { PillButton } from '@genflowly/component-library';
import { searchUserByUsername } from '../../../services/userService';
import { SearchUserResponse } from '../../../models/user.models';
import styles from './ShareModal.module.scss';

export type VisibilityMode = 'PRIVATE' | 'PUBLIC' | 'SPECIFIC';

interface ShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (mode: VisibilityMode, users: SearchUserResponse[], removedUsers: SearchUserResponse[]) => Promise<void>;
    entityId?: string;
    fetchSharedUsers?: (entityId: string) => Promise<SearchUserResponse[]>;
}

const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, onSave, entityId, fetchSharedUsers }) => {
    const { t } = useTranslation();
    const { getAccessTokenSilently } = useAuth0();
    const [mode, setMode] = useState<VisibilityMode>('PRIVATE');
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState<SearchUserResponse[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [selectedUsers, setSelectedUsers] = useState<SearchUserResponse[]>([]);
    const [initialUsers, setInitialUsers] = useState<SearchUserResponse[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoadingInitial, setIsLoadingInitial] = useState(false);
    const [publicRole, setPublicRole] = useState<'VIEW' | 'EDIT'>('VIEW');

    useEffect(() => {
        if (!isOpen) {
            setMode('PRIVATE');
            setSearchTerm('');
            setSearchResults([]);
            setSelectedUsers([]);
            setInitialUsers([]);
        } else if (entityId && fetchSharedUsers) {
            setIsLoadingInitial(true);
            fetchSharedUsers(entityId)
                .then(users => {
                    const publicUser = users.find(u => u.customerId === 'PUBLIC');
                    if (publicUser) {
                        setMode('PUBLIC');
                        setPublicRole(publicUser.role as 'VIEW' | 'EDIT' || 'VIEW');
                        const specificUsers = users.filter(u => u.customerId !== 'PUBLIC');
                        setSelectedUsers(specificUsers);
                        setInitialUsers(users);
                    } else if (users.length > 0) {
                        setMode('SPECIFIC');
                        setSelectedUsers(users);
                        setInitialUsers(users);
                    } else {
                        setMode('PRIVATE');
                        setInitialUsers([]);
                    }
                })
                .catch(err => {
                    console.error('Failed to fetch shared users', err);
                    setMode('PRIVATE');
                })
                .finally(() => {
                    setIsLoadingInitial(false);
                });
        }
    }, [isOpen, entityId, fetchSharedUsers]);

    useEffect(() => {
        const delayDebounceFn = setTimeout(async () => {
            if (searchTerm.length >= 3) {
                setIsSearching(true);
                try {
                    const token = await getAccessTokenSilently();
                    const result = await searchUserByUsername(token, searchTerm);
                    setSearchResults(result || []);
                } catch (err) {
                    console.error(err);
                    setSearchResults([]);
                } finally {
                    setIsSearching(false);
                }
            } else {
                setSearchResults([]);
            }
        }, 500);

        return () => clearTimeout(delayDebounceFn);
    }, [searchTerm, getAccessTokenSilently]);

    const handleAddUser = (user: SearchUserResponse) => {
        if (!selectedUsers.some(u => u.customerId === user.customerId)) {
            setSelectedUsers(prev => [...prev, { ...user, role: 'VIEW' }]);
            setSearchTerm('');
            setSearchResults([]);
        }
    };

    const handleRemoveUser = (customerId: string) => {
        setSelectedUsers(prev => prev.filter(u => u.customerId !== customerId));
    };

    const handleRoleChange = (customerId: string, role: 'VIEW' | 'EDIT') => {
        setSelectedUsers(prev => prev.map(u => u.customerId === customerId ? { ...u, role } : u));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            let finalUsers: SearchUserResponse[] = [];
            if (mode === 'SPECIFIC') {
                finalUsers = selectedUsers;
            } else if (mode === 'PUBLIC') {
                finalUsers = [{
                    customerId: 'PUBLIC',
                    username: 'Public',
                    role: publicRole
                }];
            }
            
            const removedUsers = initialUsers.filter(initialUser => 
                !finalUsers.some(finalUser => finalUser.customerId === initialUser.customerId)
            );
            
            await onSave(mode, finalUsers, removedUsers);
            onClose();
        } catch (err) {
            console.error(err);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t('common.shareModal.title')}>
            {isLoadingInitial ? (
                <div style={{ padding: '20px', textAlign: 'center' }}>{t('common.shareModal.loading')}</div>
            ) : (
            <div className={styles.container}>
                <div className={styles.optionsGroup}>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'PRIVATE'} 
                            onChange={() => setMode('PRIVATE')} 
                        />
                        <span>{t('common.shareModal.notSharedPrivate')}</span>
                    </label>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'PUBLIC'} 
                            onChange={() => setMode('PUBLIC')} 
                        />
                        <span>{t('common.shareModal.makePublicToEveryone')}</span>
                    </label>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'SPECIFIC'} 
                            onChange={() => setMode('SPECIFIC')} 
                        />
                        <span>{t('common.shareModal.shareWithOnlySomeUsers')}</span>
                    </label>
                </div>

                {mode === 'PUBLIC' && (
                    <div className={styles.publicSection}>
                        <span>{t('common.shareModal.roleForEveryone')}</span>
                        <select 
                            value={publicRole} 
                            onChange={(e) => setPublicRole(e.target.value as 'VIEW' | 'EDIT')}
                            className={styles.roleSelect}
                        >
                            <option value="VIEW">{t('common.shareModal.view')}</option>
                            <option value="EDIT">{t('common.shareModal.edit')}</option>
                        </select>
                    </div>
                )}

                {mode === 'SPECIFIC' && (
                    <div className={styles.specificSection}>
                        <div className={styles.searchRow}>
                            <input
                                type="text"
                                placeholder={t('common.shareModal.searchUsernamePlaceholder')}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className={styles.searchInput}
                            />
                        </div>
                        {isSearching && <div className={styles.searchingText}>{t('common.shareModal.searching')}</div>}
                        {searchResults.length > 0 && (
                            <div className={styles.suggestionsList}>
                                {searchResults.map(user => (
                                    <div 
                                        key={user.customerId} 
                                        className={styles.suggestionItem}
                                        onClick={() => handleAddUser(user)}
                                    >
                                        <strong>{user.username}</strong> {user.name ? `(${user.name})` : ''}
                                    </div>
                                ))}
                            </div>
                        )}
                        {searchResults.length === 0 && searchTerm.length >= 3 && !isSearching && (
                            <div className={styles.searchMiss}>
                                {t('common.shareModal.noUsersFound', { searchTerm })}
                            </div>
                        )}
                        
                        {selectedUsers.length > 0 && (
                            <div className={styles.selectedSection}>
                                <h4>{t('common.shareModal.sharedWith')}</h4>
                                <div className={styles.tagsContainer}>
                                    {selectedUsers.map(user => (
                                        <div key={user.customerId} className={styles.tag}>
                                            <span>{user.username}</span>
                                            <select 
                                                value={user.role || 'VIEW'} 
                                                onChange={(e) => handleRoleChange(user.customerId, e.target.value as 'VIEW' | 'EDIT')}
                                                className={styles.roleSelect}
                                            >
                                                <option value="VIEW">{t('common.shareModal.view')}</option>
                                                <option value="EDIT">{t('common.shareModal.edit')}</option>
                                            </select>
                                            <button onClick={() => handleRemoveUser(user.customerId)}>&times;</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className={styles.actions}>
                    <PillButton
                        label={t('common.shareModal.cancel')}
                        variant="secondary"
                        onClick={onClose}
                        disabled={isSaving}
                    />
                    <PillButton
                        label={isSaving ? t('common.shareModal.saving') : t('common.shareModal.save')}
                        variant="primary" 
                        onClick={handleSave} 
                        disabled={isSaving || (mode === 'SPECIFIC' && selectedUsers.length === 0)} 
                    />
                </div>
            </div>
            )}
        </Modal>
    );
};

export default ShareModal;
