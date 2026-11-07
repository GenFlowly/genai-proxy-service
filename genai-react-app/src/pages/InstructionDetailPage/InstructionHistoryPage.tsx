import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { DetailShell, Timeline, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { instructionHistory, instructionPath, useInstructionPage } from './instructionDetail'

/** An instruction's versions on their own page, each with what changed. */
export default function InstructionHistoryPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { instructionId, versions, latest, loading } = useInstructionPage()
    const detailPath = instructionPath(instructionId)

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('instructionDetail.page.versions')}
            subtitle={latest?.name}
            breadcrumbs={[
                { label: t('instructionDetail.instructionDetailPage.breadcrumbInstructions'), onClick: () => navigate('/instructions') },
                { label: latest?.name || t('instructionDetail.page.title'), onClick: () => navigate(detailPath) },
                { label: t('instructionDetail.page.versions') },
            ]}
            back={{ label: t('instructionDetail.page.back'), to: detailPath }}
            data-testid="instruction-history-page"
        >
            {loading && <div className={styles.state}>{t('instructionDetail.page.loading')}</div>}
            {latest && (
                <>
                    <p className={styles.intro}>{t('instructionDetail.page.historyIntro')}</p>
                    <Timeline entries={instructionHistory(versions, instructionId)} label={t('instructionDetail.page.versions')} untitled="" deleted="" />
                </>
            )}
        </DetailShell>
    )
}
