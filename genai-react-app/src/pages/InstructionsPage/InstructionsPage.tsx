import React, { useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import styles from './InstructionsPage.module.scss';
import {
    InstructionTile,
    PageHeader,
    PillButton,
} from '@genflowly/component-library';
import { useNavigate } from 'react-router-dom';
import Navbar from '../../components/navbar/Navbar';

export default function InstructionsPage() {
    const { t } = useTranslation();
    const { customerInstructions, refreshInstructions, user } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        refreshInstructions();
    }, [refreshInstructions]);

    // Filter instructions to show only the latest version for each ID
    const uniqueInstructions = useMemo(() => {
        if (!customerInstructions) return [];
        const map = new Map<string, typeof customerInstructions[0]>();
        customerInstructions.forEach(inst => {
            const existing = map.get(inst.id);
            if (!existing || inst.version > existing.version) {
                map.set(inst.id, inst);
            }
        });
        return Array.from(map.values());
    }, [customerInstructions]);

    return (
        <div className={styles.page}>
            <Navbar />
            <PageHeader
                title={t('instructionsPage.instructionsPage.title')}
                actions={
                    <PillButton
                        label={t('instructionsPage.instructionsPage.createInstruction')}
                        variant="primary"
                        onClick={() => navigate('/instructions/new')}
                    />
                }
            />
            <div className={styles.pageContainer}>
            {uniqueInstructions.length === 0 ? (
                <div className={styles.emptyState}>
                    <p>{t('instructionsPage.instructionsPage.emptyState')}</p>
                </div>
            ) : (
                <div className={styles.grid}>
                    {uniqueInstructions.map(instruction => (
                        <InstructionTile
                            key={instruction.id}
                            title={instruction.name || t('common.instructionTile.untitledInstruction')}
                            detail={instruction.instruction}
                            icon={instruction.icon || undefined}
                            color={instruction.color || undefined}
                            tags={instruction.tags || undefined}
                            version={instruction.version}
                            // The list only knows the creator for the user's own
                            // instructions; shared ones omit the avatar
                            owner={
                                instruction.role === 'OWNER' && user?.name
                                    ? { name: user.name, avatarUrl: user.picture }
                                    : undefined
                            }
                            onClick={() => navigate(`/instructions/${instruction.id}`)}
                            data-testid={`instruction-tile-${instruction.id}`}
                        />
                    ))}
                </div>
            )}
        </div>
        </div>
    );
}
