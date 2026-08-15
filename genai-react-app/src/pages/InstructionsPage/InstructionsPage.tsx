import React, { useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { InstructionTile } from '../../components/common/InstructionTile/InstructionTile';
import styles from './InstructionsPage.module.scss';
import PillButton from '../../components/common/PillButton/PillButton';
import { useNavigate } from 'react-router-dom';
import Navbar from '../../components/navbar/Navbar';

export default function InstructionsPage() {
    const { t } = useTranslation();
    const { customerInstructions, refreshInstructions } = useAuth();
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
            <div className={styles.pageContainer}>
                <div className={styles.header}>
                <h1 className={styles.title}>{t('instructionsPage.instructionsPage.title')}</h1>
                <PillButton
                    label={t('instructionsPage.instructionsPage.createInstruction')}
                    variant="primary"
                    onClick={() => navigate('/instructions/new')} 
                />
            </div>
            
            {uniqueInstructions.length === 0 ? (
                <div className={styles.emptyState}>
                    <p>{t('instructionsPage.instructionsPage.emptyState')}</p>
                </div>
            ) : (
                <div className={styles.grid}>
                    {uniqueInstructions.map(instruction => (
                        <InstructionTile key={instruction.id} instruction={instruction} />
                    ))}
                </div>
            )}
        </div>
        </div>
    );
}
