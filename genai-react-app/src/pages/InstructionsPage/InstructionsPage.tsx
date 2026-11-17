import React, { useMemo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import styles from './InstructionsPage.module.scss';
import {
    Grid,
    GridCol,
    InputTextWithHint,
    InstructionTile,
    PageHeader,
    PillButton,
    ScrollArea,
} from '@genflowly/component-library';
import { useNavigate } from 'react-router';
import Navbar from '../../components/navbar/Navbar';
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader';
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints';

export default function InstructionsPage() {
    const { t } = useTranslation();
    const { customerInstructions, refreshInstructions, user } = useAuth();
    const navigate = useNavigate();
    const { isMobile } = useResponsiveBreakpoints();
    const [search, setSearch] = useState('');

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

    // Client-side search over name and instruction text
    const visibleInstructions = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return uniqueInstructions;
        return uniqueInstructions.filter(inst =>
            (inst.name || '').toLowerCase().includes(query) ||
            (inst.instruction || '').toLowerCase().includes(query)
        );
    }, [uniqueInstructions, search]);

    return (
        <div className={styles.page}>
            {/* 📱 Mobile: no navbar/header band — a transparent overlay header
                floats over the full-screen content instead */}
            {isMobile ? (
                <MobileHeader
                    title={t('instructionsPage.instructionsPage.title')}
                    menuItems={[
                        {
                            label: t('instructionsPage.instructionsPage.createInstruction'),
                            onClick: () => navigate('/instructions/new'),
                            'data-testid': 'create-instruction-button',
                        },
                    ]}
                />
            ) : (
                <>
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
                </>
            )}
            <ScrollArea className={styles.pageContainer}>
            {uniqueInstructions.length > 0 && (
                <div className={styles.searchBox}>
                    <InputTextWithHint
                        placeholder={t('instructionsPage.instructionsPage.searchPlaceholder')}
                        value={search}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                        data-testid="instructions-search"
                    />
                </div>
            )}
            {uniqueInstructions.length === 0 ? (
                <div className={styles.emptyState}>
                    <p>{t('instructionsPage.instructionsPage.emptyState')}</p>
                </div>
            ) : visibleInstructions.length === 0 ? (
                <div className={styles.emptyState}>
                    <p>{t('instructionsPage.instructionsPage.noSearchResults')}</p>
                </div>
            ) : (
                <Grid data-testid="instructions-grid">
                    {visibleInstructions.map(instruction => (
                        <GridCol key={instruction.id} span={12} md={6} lg={4}>
                            <InstructionTile
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
                        </GridCol>
                    ))}
                </Grid>
            )}
        </ScrollArea>
        </div>
    );
}
