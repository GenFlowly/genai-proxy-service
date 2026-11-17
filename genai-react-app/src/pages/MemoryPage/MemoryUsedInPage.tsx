import React from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { ConversationList, DetailShell, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useMemoryUsage } from '../../hooks/queries/useMemories'
import { memorySubPath, unlistedReplies, usageByConversation, usageSummary, useMemoryPage } from './memoryDetail'

/** The conversations a memory was used in, one row each, newest first. */
export default function MemoryUsedInPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { memoryId, memory, scope } = useMemoryPage()
    const usageQuery = useMemoryUsage(memoryId)
    usePageTitle()
    const detailPath = memory ? memorySubPath(memory.memoryId, '', scope) : '/memory'
    const uses = (usageQuery.data?.pages ?? []).flatMap(page => page.items)
    const items = usageByConversation(uses)
    const unlisted = memory ? unlistedReplies(memory, uses.length, usageQuery.isSuccess && !usageQuery.hasNextPage) : 0

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('memoryPage.page.usedIn')}
            subtitle={memory ? usageSummary(memory) : undefined}
            breadcrumbs={[
                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                { label: t('memoryPage.page.title'), onClick: () => navigate(detailPath) },
                { label: t('memoryPage.page.usedIn') },
            ]}
            back={{ label: t('memoryPage.page.back'), to: detailPath }}
            data-testid="memory-usage-page"
        >
            <p className={styles.intro}>{t('memoryPage.page.usedInIntro')}</p>
            {usageQuery.isPending && <div className={styles.state}>{t('memoryPage.usage.loading')}</div>}
            {usageQuery.isError && <div className={styles.state}>{t('memoryPage.usage.loadFailed')}</div>}
            {usageQuery.isSuccess && items.length === 0 && (
                <div className={styles.state} data-testid="memory-usage-empty">
                    {unlisted > 0 ? t('memoryPage.page.unlisted', { count: unlisted }) : t('memoryPage.usage.empty')}
                </div>
            )}
            {items.length > 0 && (
                <ConversationList
                    items={items}
                    label={t('memoryPage.page.usedIn')}
                    untitled={t('memoryPage.changes.untitledConversation')}
                    deleted={t('memoryPage.changes.deletedConversation')}
                />
            )}
            {usageQuery.hasNextPage && (
                <PillButton
                    variant="secondary"
                    label={usageQuery.isFetchingNextPage ? t('memoryPage.usage.loading') : t('memoryPage.usage.loadMore')}
                    onClick={() => usageQuery.fetchNextPage()}
                    disabled={usageQuery.isFetchingNextPage}
                    data-testid="memory-usage-load-more"
                />
            )}
            {items.length > 0 && unlisted > 0 && (
                <p className={styles.intro} data-testid="memory-usage-unlisted">{t('memoryPage.page.unlistedMore', { count: unlisted })}</p>
            )}
        </DetailShell>
    )
}
