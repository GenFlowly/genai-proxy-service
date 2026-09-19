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
import {
    InstructionEditor,
    Breadcrumbs,
    BreadcrumbItem,
    PillButton,
    pageHeaderStyles,
    ScrollArea,
} from '@genflowly/component-library';
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
    // null = follow the latest version; a number pins an older version
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

    // Newest first; the page shows this as the version-history sidebar
    const versionHistory = customerInstructions
        .filter(i => i.id === instructionId)
        .sort((a, b) => b.version - a.version);

    // The version currently shown in the editor (pinned or latest)
    const currentVersion = (selectedVersion !== null
        ? versionHistory.find(v => v.version === selectedVersion)
        : undefined) ?? versionHistory[0];

    // Header trail: Instructions › <instruction name | Create Instruction>
    const breadcrumbItems: BreadcrumbItem[] = [
        {
            label: t('instructionDetail.instructionDetailPage.breadcrumbInstructions'),
            onClick: () => navigate('/instructions'),
        },
        {
            label: isNew
                ? t('instructionDetail.instructionDetailPage.createTitle')
                : currentVersion?.name || t('instructionDetail.instructionDetailPage.editTitle'),
        },
    ];

    useEffect(() => {
        refreshInstructions();
    }, [refreshInstructions]);

    useEffect(() => {
        setSelectedVersion(null);
    }, [instructionId]);

    useEffect(() => {
        if (!isNew && instructionId) {
            const matching = customerInstructions.filter(i => i.id === instructionId);
            const latest = matching.sort((a, b) => b.version - a.version)[0];
            const current = (selectedVersion !== null
                ? matching.find(i => i.version === selectedVersion)
                : undefined) ?? latest;

            if (current) {
                setName(current.name || '');
                setInstructionText(current.instruction || '');
                setRole(current.role || 'VIEW');
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
    }, [instructionId, isNew, customerInstructions, selectedVersion, isInstructionsLoaded, isAuthenticated, loginWithRedirect, navigate, t]);

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
                setSelectedVersion(null); // Jump back to the latest version
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
            <ScrollArea className={styles.pageContainer}>
                <div className={pageHeaderStyles.header}>
                    <Breadcrumbs items={breadcrumbItems} variant="onHeader" />
                    <div className={pageHeaderStyles.actions}>
                        {!isNew && role !== 'VIEW' && entitlements.canShare && (
                            <PillButton
                                label={t('instructionDetail.instructionDetailPage.share')}
                                variant="secondary"
                                className={styles.shareButton}
                                onClick={() => setIsShareModalOpen(true)}
                                disabled={isLoading}
                            />
                        )}
                    </div>
                </div>
                <InstructionEditor
                    name={name}
                    onNameChange={setName}
                    instructionText={instructionText}
                    onInstructionTextChange={setInstructionText}
                    isNew={isNew}
                    readOnly={role === 'VIEW'}
                    isLoading={isLoading}
                    canDelete={role === 'OWNER'}
                    onSave={handleSave}
                    onDelete={handleDelete}
                    editorId="instruction-detail-editor"
                    versions={versionHistory.map(v => ({
                        version: v.version,
                        details: v.name || undefined,
                    }))}
                    icon={currentVersion?.icon || undefined}
                    color={currentVersion?.color || undefined}
                    role={currentVersion?.role}
                    category={currentVersion?.category || undefined}
                    tags={currentVersion?.tags || undefined}
                    selectedVersion={selectedVersion ?? versionHistory[0]?.version}
                    onSelectVersion={setSelectedVersion}
                    versionsLoading={!isNew && !isInstructionsLoaded && versionHistory.length === 0}
                    labels={{
                        delete: t('instructionDetail.instructionDetailPage.delete'),
                        save: t('instructionDetail.instructionDetailPage.save'),
                        saving: t('instructionDetail.instructionDetailPage.savingLabel'),
                        readonlyBanner: t('instructionDetail.instructionDetailPage.readonlyBanner'),
                        nameHint: t('instructionDetail.instructionDetailPage.nameHint'),
                        namePlaceholder: t('instructionDetail.instructionDetailPage.namePlaceholder'),
                        versionsTitle: t('instructionDetail.instructionDetailPage.versionsTitle'),
                        versionsEmpty: t('instructionDetail.instructionDetailPage.versionsEmpty'),
                        versionsError: t('instructionDetail.instructionDetailPage.versionsError'),
                        accessLevel: t('instructionDetail.instructionDetailPage.accessLevel'),
                        latestTooltip: t('instructionDetail.instructionDetailPage.latestTooltip'),
                    }}
                />

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
            </ScrollArea>
        </div>
    );
}
