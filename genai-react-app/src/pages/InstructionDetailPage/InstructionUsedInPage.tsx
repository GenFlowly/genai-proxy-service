import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ConversationList, DetailShell, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useInstructionUsage } from '../../hooks/queries/useInstructionDetail'
import { formatServerDateOnly } from '../../utils/timeUtils'
import { instructionPath, usageSummary, useInstructionPage } from './instructionDetail'

/** The caller's conversations that used an instruction, newest first. */
export default function InstructionUsedInPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { instructionId, latest } = useInstructionPage()
    const usageQuery = useInstructionUsage(instructionId, !!latest)
    const usage = usageQuery.data
    const detailPath = instructionPath(instructionId)
    const omitted = usage?.omitted ?? 0
    const deleted = usage && omitted === 0 ? Math.max(0, usage.usageCount - usage.conversations.length) : 0

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('instructionDetail.page.usedIn')}
            subtitle={usage ? usageSummary(usage) : undefined}
            breadcrumbs={[
                { label: t('instructionDetail.instructionDetailPage.breadcrumbInstructions'), onClick: () => navigate('/instructions') },
                { label: latest?.name || t('instructionDetail.page.title'), onClick: () => navigate(detailPath) },
                { label: t('instructionDetail.page.usedIn') },
            ]}
            back={{ label: t('instructionDetail.page.back'), to: detailPath }}
            data-testid="instruction-usage-page"
        >
            <p className={styles.intro}>{t('instructionDetail.page.usedInIntro')}</p>
            {usageQuery.isPending && <div className={styles.state}>{t('instructionDetail.page.loading')}</div>}
            {usageQuery.isError && <div className={styles.state}>{t('instructionDetail.page.usageFailed')}</div>}
            {usage && usage.usageCount === 0 && <div className={styles.state}>{t('instructionDetail.page.usageNever')}</div>}
            {usage && usage.conversations.length > 0 && (
                <ConversationList
                    items={usage.conversations.map(conversation => ({
                        key: conversation.conversationId,
                        conversationId: conversation.conversationId,
                        title: conversation.title,
                        available: true,
                        meta: conversation.firstUsedAt
                            ? t('instructionDetail.page.firstUsed', { date: formatServerDateOnly(conversation.firstUsedAt) })
                            : undefined,
                    }))}
                    label={t('instructionDetail.page.usedIn')}
                    untitled={t('memoryPage.changes.untitledConversation')}
                    deleted={t('memoryPage.changes.deletedConversation')}
                />
            )}
            {omitted > 0 && <p className={styles.intro}>{t('instructionDetail.page.showingNewest', { count: usage?.conversations.length ?? 0 })}</p>}
            {deleted > 0 && <p className={styles.intro}>{t('instructionDetail.page.deletedMore', { count: deleted })}</p>}
        </DetailShell>
    )
}
