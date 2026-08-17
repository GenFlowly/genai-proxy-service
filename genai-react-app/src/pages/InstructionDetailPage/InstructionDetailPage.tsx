import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useAuth0 } from '@auth0/auth0-react';
import { 
    createInstruction, 
    shareInstruction, 
    unshareInstruction,
    deleteInstruction,
    getInstructionSharedUsers
} from '../../services/instructionService';
import { PromptEditor } from '@genflowly/component-library';
import { PillButton } from '@genflowly/component-library';
import { InputTextWithHint } from '@genflowly/component-library';
import ShareModal, { VisibilityMode } from '../../components/common/ShareModal/ShareModal';
import { SearchUserResponse } from '../../models/user.models';
import styles from './InstructionDetailPage.module.scss';
import Navbar from '../../components/navbar/Navbar';

export default function InstructionDetailPage() {
    const { t } = useTranslation();
    const { instructionId } = useParams<{ instructionId: string }>();
    const navigate = useNavigate();
    const { getAccessTokenSilently } = useAuth0();
    const { customerInstructions, refreshInstructions, updateInstruction, isAuthenticated, isInstructionsLoaded, loginWithRedirect, entitlements } = useAuth();

    const isNew = instructionId === 'new';
    
    const [name, setName] = useState('');
    const [instructionText, setInstructionText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const [role, setRole] = useState<'OWNER' | 'EDIT' | 'VIEW'>('OWNER');

    useEffect(() => {
        refreshInstructions();
    }, [refreshInstructions]);

    useEffect(() => {
        if (!isNew && instructionId) {
            // Find the latest version of this instruction
            const matching = customerInstructions.filter(i => i.id === instructionId);
            const latest = matching.sort((a, b) => b.version - a.version)[0];
            
            if (latest) {
                setName(latest.name || '');
                setInstructionText(latest.instruction || '');
                setRole(latest.role || 'VIEW');
            } else if (isInstructionsLoaded) {
                if (!isAuthenticated) {
                    loginWithRedirect({ appState: { returnTo: window.location.pathname } });
                } else {
                    alert(t('instructionDetail.instructionDetailPage.noAccessAlert'));
                    navigate('/instructions');
                }
            }
        } else if (isNew) {
            if (isInstructionsLoaded && !isAuthenticated) {
                loginWithRedirect({ appState: { returnTo: window.location.pathname } });
            }
            setRole('OWNER');
        }
    }, [instructionId, isNew, customerInstructions, isInstructionsLoaded, isAuthenticated, loginWithRedirect, navigate, t]);

    const handleSave = async () => {
        if (!instructionText.trim()) return;
        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            const response = await createInstruction(token, {
                instruction: instructionText,
                instructionName: name || undefined,
                existingInstructionId: isNew ? undefined : instructionId
            });

            if (response.id) {
                updateInstruction(response);
                refreshInstructions();
                if (isNew || response.id !== instructionId) { // Handles branching
                    navigate(`/instructions/${response.id}`, { replace: true });
                }
            }
        } catch (error) {
            console.error("Failed to save instruction", error);
            alert(t('instructionDetail.instructionDetailPage.saveFailedAlert'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleShareClick = () => {
        setIsShareModalOpen(true);
    };

    const handleShareSave = async (mode: VisibilityMode, users: SearchUserResponse[], removedUsers: SearchUserResponse[]) => {
        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            for (const user of users) {
                await shareInstruction(token, instructionId!, user.customerId, user.role || 'VIEW');
            }
            for (const user of removedUsers) {
                await unshareInstruction(token, instructionId!, user.customerId);
            }
            alert(t('instructionDetail.instructionDetailPage.shareUpdatedAlert'));
        } catch (error) {
            console.error("Failed to share instruction", error);
            alert(t('instructionDetail.instructionDetailPage.shareFailedAlert'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!window.confirm(t('instructionDetail.instructionDetailPage.deleteConfirm'))) return;
        
        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            await deleteInstruction(token, instructionId!);
            refreshInstructions();
            navigate('/instructions');
        } catch (error) {
            console.error("Failed to delete instruction", error);
            alert(t('instructionDetail.instructionDetailPage.deleteFailedAlert'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.pageContainer}>
                <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <button className={styles.backButton} onClick={() => navigate('/instructions')}>
                        &larr; {t('instructionDetail.instructionDetailPage.back')}
                    </button>
                    <h2>{isNew ? t('instructionDetail.instructionDetailPage.createTitle') : t('instructionDetail.instructionDetailPage.editTitle')}</h2>
                </div>
                
                <div className={styles.actions}>
                    {role !== 'VIEW' && !isNew && (
                        <>
                            {entitlements.canShare && (
                                <PillButton
                                    label={t('instructionDetail.instructionDetailPage.share')}
                                    variant="secondary"
                                    onClick={handleShareClick}
                                    disabled={isLoading}
                                />
                            )}
                            {role === 'OWNER' && (
                                <PillButton
                                    label={t('instructionDetail.instructionDetailPage.delete')}
                                    variant="danger"
                                    onClick={handleDelete} 
                                    disabled={isLoading}
                                />
                            )}
                        </>
                    )}
                    {role !== 'VIEW' && (
                        <PillButton
                            label={isLoading ? t('instructionDetail.instructionDetailPage.savingLabel') : t('instructionDetail.instructionDetailPage.save')}
                            variant="primary" 
                            onClick={handleSave} 
                            disabled={isLoading || !instructionText.trim()}
                        />
                    )}
                </div>
            </div>

            <div className={styles.content}>
                {role === 'VIEW' && (
                    <div className={styles.readonlyBanner}>
                        {t('instructionDetail.instructionDetailPage.readonlyBanner')}
                    </div>
                )}
                <div className={styles.inputGroup}>
                    <InputTextWithHint
                        hint={t('instructionDetail.instructionDetailPage.nameHint')}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('instructionDetail.instructionDetailPage.namePlaceholder')}
                        disabled={role === 'VIEW'}
                    />
                </div>
                
                <div className={styles.editorContainer}>
                    <label className={styles.editorLabel}>{t('instructionDetail.instructionDetailPage.instructionPrompt')}</label>
                    <PromptEditor
                        id="instruction-detail-editor"
                        value={instructionText}
                        onChange={setInstructionText}
                        disableCache={true}
                        height="100%"
                    />
                </div>
            </div>

            <ShareModal
                isOpen={isShareModalOpen}
                onClose={() => setIsShareModalOpen(false)}
                onSave={handleShareSave}
                entityId={!isNew ? instructionId : undefined}
                fetchSharedUsers={async (id) => {
                    const token = await getAccessTokenSilently();
                    return getInstructionSharedUsers(token, id);
                }}
            />
        </div>
        </div>
    );
}
