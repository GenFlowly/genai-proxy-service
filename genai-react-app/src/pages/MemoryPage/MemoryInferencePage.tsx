import React, { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { MemoryInference } from '@genflowly/component-library'
import { DetailShell, detailStyles as styles } from '../../components/DetailPage/DetailParts'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useMemoryInference } from '../../hooks/queries/useMemories'
import { useVendorDisplayNames } from '../../hooks/useVendorDisplayNames'
import { formatServerDateOnly, formatServerDateTime } from '../../utils/timeUtils'
import { memorySubPath, useMemoryPage } from './memoryDetail'
import { memoryPath } from './memoryPaths'
import DeleteMemoryDialog from './components/DeleteMemoryDialog'

/** How a memory was inferred: the extraction run that learned or changed it, told as a story. */
export default function MemoryInferencePage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { runId } = useParams<{ runId: string }>()
    const { isNarrow } = useResponsiveBreakpoints()
    const { memoryId, memory, scope } = useMemoryPage()
    const inferenceQuery = useMemoryInference(memoryId, runId)
    const vendorName = useVendorDisplayNames()
    const [deleting, setDeleting] = useState(false)
    usePageTitle()
    const detailPath = memoryId ? memorySubPath(memoryId, '', scope) : '/memory'
    const inference = inferenceQuery.data
    const notFound = inferenceQuery.isError && (inferenceQuery.error as { status?: number })?.status === 404

    return (
        <DetailShell
            narrow={isNarrow}
            title={t('memoryInference.title')}
            subtitle={inference?.memory.text ?? memory?.text}
            breadcrumbs={[
                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                { label: t('memoryPage.page.title'), onClick: () => navigate(detailPath) },
                { label: t('memoryInference.title') },
            ]}
            back={{ label: t('memoryInference.backToMemory'), to: detailPath }}
            data-testid="memory-inference-page"
        >
            {inferenceQuery.isPending && <div className={styles.state}>{t('memoryPage.list.loading')}</div>}
            {inferenceQuery.isError && (
                <div className={styles.state}>{notFound ? t('memoryInference.notFound') : t('memoryInference.loadFailed')}</div>
            )}
            {inference && (
                <MemoryInference
                    inference={inference}
                    vendorName={vendorName}
                    formatDateTime={formatServerDateTime}
                    formatDate={formatServerDateOnly}
                    onOpenConversation={conversationId => navigate(`/chat/${encodeURIComponent(conversationId)}`)}
                    onOpenMemory={id => navigate(memoryPath(id))}
                    onOpenAgent={agentId => navigate(`/agents/${encodeURIComponent(agentId)}`)}
                    onDelete={memory ? () => setDeleting(true) : undefined}
                />
            )}
            {deleting && memory && (
                <DeleteMemoryDialog
                    memory={memory}
                    from={memory.placements[0]}
                    onClose={() => setDeleting(false)}
                    onDone={() => navigate('/memory')}
                />
            )}
        </DetailShell>
    )
}
