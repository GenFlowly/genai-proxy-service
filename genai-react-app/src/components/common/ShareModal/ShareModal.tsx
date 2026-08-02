import React, { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import Modal from '../Modal/Modal';
import PillButton from '../PillButton/PillButton';
import { searchUserByUsername } from '../../../services/userService';
import { SearchUserResponse } from '../../../models/user.models';
import styles from './ShareModal.module.scss';

export type VisibilityMode = 'PRIVATE' | 'PUBLIC' | 'SPECIFIC';

interface ShareModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (mode: VisibilityMode, users: SearchUserResponse[]) => Promise<void>;
}

const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, onSave }) => {
    const { getAccessTokenSilently } = useAuth0();
    const [mode, setMode] = useState<VisibilityMode>('PRIVATE');
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResult, setSearchResult] = useState<SearchUserResponse | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [selectedUsers, setSelectedUsers] = useState<SearchUserResponse[]>([]);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            setMode('PRIVATE');
            setSearchTerm('');
            setSearchResult(null);
            setSelectedUsers([]);
        }
    }, [isOpen]);

    useEffect(() => {
        const delayDebounceFn = setTimeout(async () => {
            if (searchTerm.length >= 3) {
                setIsSearching(true);
                try {
                    const token = await getAccessTokenSilently();
                    const result = await searchUserByUsername(token, searchTerm);
                    setSearchResult(result);
                } catch (err) {
                    console.error(err);
                    setSearchResult(null);
                } finally {
                    setIsSearching(false);
                }
            } else {
                setSearchResult(null);
            }
        }, 500);

        return () => clearTimeout(delayDebounceFn);
    }, [searchTerm, getAccessTokenSilently]);

    const handleAddUser = () => {
        if (searchResult && !selectedUsers.some(u => u.customerId === searchResult.customerId)) {
            setSelectedUsers(prev => [...prev, searchResult]);
            setSearchTerm('');
            setSearchResult(null);
        }
    };

    const handleRemoveUser = (customerId: string) => {
        setSelectedUsers(prev => prev.filter(u => u.customerId !== customerId));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await onSave(mode, selectedUsers);
            onClose();
        } catch (err) {
            console.error(err);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Share Options">
            <div className={styles.container}>
                <div className={styles.optionsGroup}>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'PRIVATE'} 
                            onChange={() => setMode('PRIVATE')} 
                        />
                        <span>Not shared (Private)</span>
                    </label>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'PUBLIC'} 
                            onChange={() => setMode('PUBLIC')} 
                        />
                        <span>Make public to everyone</span>
                    </label>
                    <label className={styles.radioLabel}>
                        <input 
                            type="radio" 
                            checked={mode === 'SPECIFIC'} 
                            onChange={() => setMode('SPECIFIC')} 
                        />
                        <span>Share with only some users</span>
                    </label>
                </div>

                {mode === 'SPECIFIC' && (
                    <div className={styles.specificSection}>
                        <div className={styles.searchRow}>
                            <input
                                type="text"
                                placeholder="Search exact username..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className={styles.searchInput}
                            />
                            <PillButton
                                label={isSearching ? "Searching..." : "Add"}
                                variant="primary"
                                onClick={handleAddUser}
                                disabled={!searchResult || isSearching}
                            />
                        </div>
                        {searchResult && (
                            <div className={styles.searchHit}>
                                Found: <strong>{searchResult.username}</strong> {searchResult.name ? `(${searchResult.name})` : ''}
                            </div>
                        )}
                        {!searchResult && searchTerm.length >= 3 && !isSearching && (
                            <div className={styles.searchMiss}>
                                No user found matching "{searchTerm}" exactly.
                            </div>
                        )}
                        
                        {selectedUsers.length > 0 && (
                            <div className={styles.selectedSection}>
                                <h4>Shared with:</h4>
                                <div className={styles.tagsContainer}>
                                    {selectedUsers.map(user => (
                                        <div key={user.customerId} className={styles.tag}>
                                            <span>{user.username}</span>
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
                        label="Cancel" 
                        variant="secondary" 
                        onClick={onClose} 
                        disabled={isSaving} 
                    />
                    <PillButton 
                        label={isSaving ? "Saving..." : "Save"} 
                        variant="primary" 
                        onClick={handleSave} 
                        disabled={isSaving || (mode === 'SPECIFIC' && selectedUsers.length === 0)} 
                    />
                </div>
            </div>
        </Modal>
    );
};

export default ShareModal;
