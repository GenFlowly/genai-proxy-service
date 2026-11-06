import React from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PillButton } from '@genflowly/component-library'
import { MemoryChange, MemoryUsagePage } from '../../../models/memory.models'
import { formatServerDateTime, formatServerDateOnly } from '../../../utils/timeUtils'
import { ProjectNames, changeTitle, placementsLabel } from '../memoryLabels'
import styles from '../MemoryPage.module.scss'

function ConversationLink({ change }: { change: Pick<MemoryChange, 'conversationId' | 'conversationTitle' | 'conversationAvailable'> }) {
    const { t } = useTranslation()
    if (!change.conversationId) return null
    if (change.conversationAvailable === false) {
        return <span className={styles.muted}>{t('memoryPage.changes.deletedConversation')}</span>
    }
    return (
        <Link className={styles.logLink} to={`/chat/${encodeURIComponent(change.conversationId)}`}>
            {change.conversationTitle?.trim() || t('memoryPage.changes.untitledConversation')}
        </Link>
    )
}

interface ChangeLogProps {
    changes: MemoryChange[]
    names: ProjectNames
    /** The version on screen, highlighted in the log. */
    selectedVersion: number
}

/** How a memory was learned and every change since, newest first. Entries never change. */
export function MemoryChangeLog({ changes, names, selectedVersion }: ChangeLogProps): React.ReactElement {
    const { t } = useTranslation()

    return (
        <div role="tabpanel" aria-label={t('memoryPage.detail.changeLog')} className={styles.logPanel}>
            <p className={styles.help}>{t('memoryPage.detail.changeLogHelp')}</p>
            <ol className={styles.changeList} data-testid="memory-change-log">
                {changes.map(change => {
                    const placementChange = change.version == null
                    return (
                        <li
                            key={change.changeId}
                            className={`${styles.change} ${change.version === selectedVersion ? styles.changeSelected : ''}`}
                            data-testid={`memory-change-${change.changeId}`}
                        >
                            <div className={styles.changeHead}>
                                {change.version != null && (
                                    <span className={styles.versionBadge}>
                                        {t('memoryPage.versions.version', { version: change.version })}
                                    </span>
                                )}
                                <h3 className={styles.changeTitle}>{changeTitle(change)}</h3>
                                {placementChange && <span className={styles.muted}>{t('memoryPage.changes.noVersion')}</span>}
                                <span className={styles.spacer} />
                                <span className={styles.muted}>{formatServerDateTime(change.createdAt)}</span>
                            </div>
                            <dl className={styles.changeFacts}>
                                {change.type === 'LEGACY' && (
                                    <Fact label={t('memoryPage.changes.note')} value={t('memoryPage.changes.legacyNote', { date: formatServerDateOnly(change.createdAt) })} />
                                )}
                                {change.conversationId && (
                                    <Fact label={t('memoryPage.changes.conversation')} value={<ConversationLink change={change} />} />
                                )}
                                {change.messageId && (
                                    <Fact label={t('memoryPage.changes.message')} value={<code className={styles.mono}>{change.messageId}</code>} />
                                )}
                                {change.noteKey && <Fact label={t('memoryPage.changes.note')} value={t('memoryPage.changes.fromNote')} />}
                                {change.youSaid && <Fact label={t('memoryPage.changes.youSaid')} value={`“${change.youSaid}”`} />}
                                {change.reason && <Fact label={t('memoryPage.changes.reason')} value={change.reason} />}
                                {change.previousText != null && (
                                    <Fact label={t('memoryPage.changes.before')} value={<span className={styles.struck}>{change.previousText}</span>} />
                                )}
                                {change.text != null && (
                                    <Fact
                                        label={t(change.previousText != null ? 'memoryPage.changes.after' : 'memoryPage.changes.text')}
                                        value={change.text}
                                    />
                                )}
                                {placementChange && (
                                    <>
                                        <Fact label={t('memoryPage.changes.from')} value={placementsLabel(change.from, names)} />
                                        <Fact label={t('memoryPage.changes.to')} value={placementsLabel(change.to, names)} />
                                    </>
                                )}
                            </dl>
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className={styles.fact}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    )
}

const HOW_KEYS: Record<string, string> = {
    core: 'memoryPage.usage.howCore',
    recalled: 'memoryPage.usage.howRecalled',
    search: 'memoryPage.usage.howSearch',
}

interface UsageLogProps {
    pages: MemoryUsagePage[]
    total: number
    isLoading: boolean
    isError: boolean
    hasMore: boolean
    loadingMore: boolean
    onLoadMore: () => void
}

/** The replies a memory was sent to the model for, newest first. */
export function MemoryUsageLog({ pages, total, isLoading, isError, hasMore, loadingMore, onLoadMore }: UsageLogProps): React.ReactElement {
    const { t } = useTranslation()
    const items = pages.flatMap(page => page.items)

    return (
        <div role="tabpanel" aria-label={t('memoryPage.detail.usageLog')} className={styles.logPanel}>
            <p className={styles.help}>{t('memoryPage.detail.usageLogHelp')}</p>
            {isLoading && <p className={styles.muted}>{t('memoryPage.usage.loading')}</p>}
            {isError && <p className={styles.muted}>{t('memoryPage.usage.loadFailed')}</p>}
            {!isLoading && !isError && items.length === 0 && <p className={styles.muted}>{t('memoryPage.usage.empty')}</p>}
            {items.length > 0 && (
                <ul className={styles.usageList} data-testid="memory-usage-log">
                    {items.map(usage => (
                        <li key={`${usage.messageId}-${usage.usedAt}`} className={styles.usageRow}>
                            <span className={styles.usageConversation}>
                                <ConversationLink change={usage} />
                            </span>
                            <code className={`${styles.mono} ${styles.muted}`}>{usage.messageId}</code>
                            <span className={styles.muted}>{HOW_KEYS[usage.how] ? t(HOW_KEYS[usage.how]) : usage.how}</span>
                            <span className={styles.muted}>{formatServerDateTime(usage.usedAt)}</span>
                        </li>
                    ))}
                </ul>
            )}
            {items.length > 0 && (
                <div className={styles.usageFoot}>
                    <span className={styles.muted}>{t('memoryPage.usage.showing', { shown: items.length, total })}</span>
                    {hasMore && (
                        <PillButton
                            variant="secondary"
                            label={loadingMore ? t('memoryPage.usage.loading') : t('memoryPage.usage.loadMore')}
                            onClick={onLoadMore}
                            disabled={loadingMore}
                            data-testid="memory-usage-load-more"
                        />
                    )}
                </div>
            )}
        </div>
    )
}
