import React from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { DetailShell, Timeline, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { memoryHistory, memorySubPath, useMemoryPage } from './memoryDetail'

/** A memory's history on its own page: every change, with what caused it. */
export default function MemoryHistoryPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { isNarrow } = useResponsiveBreakpoints()
    const { detailQuery, detail, memory, names, scope } = useMemoryPage()
    usePageTitle()
    const detailPath = memory ? memorySubPath(memory.memoryId, '', scope) : '/memory'

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('memoryPage.page.history')}
            subtitle={memory?.text}
            breadcrumbs={[
                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                { label: t('memoryPage.page.title'), onClick: () => navigate(detailPath) },
                { label: t('memoryPage.page.history') },
            ]}
            back={{ label: t('memoryPage.page.back'), to: detailPath }}
            data-testid="memory-history-page"
        >
            {detailQuery.isPending && <div className={styles.state}>{t('memoryPage.list.loading')}</div>}
            {detailQuery.isError && <div className={styles.state}>{t('memoryPage.detail.loadFailed')}</div>}
            {memory && detail && (
                <>
                    <p className={styles.intro}>{t('memoryPage.page.historyIntro')}</p>
                    <Timeline
                        entries={memoryHistory(detail.changes, memory, names, scope)}
                        label={t('memoryPage.page.history')}
                        untitled={t('memoryPage.changes.untitledConversation')}
                        deleted={t('memoryPage.changes.deletedConversation')}
                    />
                </>
            )}
        </DetailShell>
    )
}
