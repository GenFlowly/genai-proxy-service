import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { PillButton, pageHeaderStyles } from '@genflowly/component-library'
import {
    ConversationList,
    DetailColumns,
    DetailRows,
    DetailShell,
    MoreMenu,
    SideCard,
    Timeline,
    UsageStats,
    detailStyles as styles,
    focusAtEnd,
} from '../../components/DetailPage/DetailParts'
import { ICONS } from '../../constants/icons'
import { useAuth } from '../../context/AuthContext'
import { useLayout } from '../../context/LayoutContext'
import { useToast } from '../../context/ToastContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useMemories, useMemoryDetail, useMemoryUsage, useProjects } from '../../hooks/queries/useMemories'
import { MemoryScope, memoryCounts, placementIn, scopeFromParam, scopeToParam } from '../../models/memory.models'
import { MemoryApiError, editMemory } from '../../services/memoriesService'
import { formatServerDateOnly } from '../../utils/timeUtils'
import MemoryMenuContent from './components/MemoryMenuContent'
import MoveMemoryDialog from './components/MoveMemoryDialog'
import DeleteMemoryDialog from './components/DeleteMemoryDialog'
import { projectNames, scopeTitle } from './memoryLabels'
import { memoryPath } from './MemoryPage'
import { MAX_TEXT_CHARS, appliesLabel, lastUsedLabel, memoryHistory, memorySubPath, scopeOf, usageByConversation, usageSummary } from './memoryDetail'

// Conversations shown in the desktop Usage card before "See all usage".
const SIDE_CONVERSATIONS = 4

/**
 * One memory: its text with one Edit action, where it applies, how it was
 * used and its history. Phones show the last three as rows that open their
 * own pages; desktop shows the history under the text and the rest beside it.
 * `?version=N` shows an older version, which Restore saves as a new one.
 */
export default function MemoryDetailPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { memoryId } = useParams<{ memoryId: string }>()
    const [params] = useSearchParams()
    const { isNarrow } = useResponsiveBreakpoints()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    const { getAccessTokenSilently } = useAuth()
    const { showToast } = useToast()
    usePageTitle()

    const detailQuery = useMemoryDetail(memoryId)
    const memoriesQuery = useMemories()
    const projectsQuery = useProjects()
    const usageQuery = useMemoryUsage(memoryId, !isNarrow)
    const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
    const names = useMemo(() => projectNames(projects), [projects])
    const counts = useMemo(() => memoryCounts(memoriesQuery.data ?? []), [memoriesQuery.data])
    const detail = detailQuery.data
    const memory = detail?.memory

    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)
    const [dialog, setDialog] = useState<'move' | 'copy' | 'delete' | null>(null)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    useEffect(() => setEditing(false), [memoryId])

    const requested = params.get('scope') ? scopeFromParam(params.get('scope')) : null
    const scope: MemoryScope | null = memory
        ? (requested && placementIn(memory, requested) ? requested : scopeOf(memory))
        : requested
    const from = memory && scope ? placementIn(memory, scope) ?? memory.placements[0] : undefined
    const latest = memory?.version ?? 1
    const asked = Number(params.get('version'))
    const shownChange = detail?.versions.find(v => v.version === asked && asked !== latest)
        ?? detail?.versions.find(v => v.version === latest)
    const shownVersion = shownChange?.version ?? latest
    const older = shownVersion !== latest
    const shownText = older ? shownChange?.text ?? '' : memory?.text ?? ''
    const listPath = scope ? `/memory?scope=${encodeURIComponent(scopeToParam(scope))}` : '/memory'
    const latestPath = memory ? memorySubPath(memory.memoryId, '', scope) : listPath
    const notFound = detailQuery.error instanceof MemoryApiError && detailQuery.error.status === 404
    const trimmed = draft.trim()
    const canSave = !!memory && trimmed.length > 0 && trimmed.length <= MAX_TEXT_CHARS && trimmed !== memory.text

    const startEdit = () => {
        if (!memory) return
        if (isNarrow) {
            navigate(memorySubPath(memory.memoryId, '/edit', scope, older ? { version: String(shownVersion) } : {}))
            return
        }
        setDraft(shownText)
        setEditing(true)
    }

    const save = async () => {
        if (!memory || !canSave) return
        setSaving(true)
        try {
            const updated = await editMemory(await getAccessTokenSilently(), memory.memoryId, trimmed, memory.version)
            showToast(t('memoryPage.detail.saved', { version: updated.version }))
            setEditing(false)
            if (older) navigate(latestPath, { replace: true })
        } catch (error) {
            console.error('Failed to save memory:', error)
            const conflict = error instanceof MemoryApiError && error.status === 409
            showToast(t(conflict ? 'memoryPage.detail.conflict' : 'memoryPage.detail.saveFailed'))
            if (conflict) detailQuery.refetch()
        } finally {
            setSaving(false)
        }
    }

    const menuItems = memory && from ? [
        { label: t('memoryPage.list.moveTo'), onClick: () => setDialog('move'), 'data-testid': 'memory-detail-move' },
        ...(from.projectId ? [{ label: t('memoryPage.list.copyToProject'), onClick: () => setDialog('copy'), 'data-testid': 'memory-detail-copy' }] : []),
        { label: t('memoryPage.list.delete'), onClick: () => setDialog('delete'), 'data-testid': 'memory-detail-delete' },
    ] : undefined

    const history = memory && detail ? memoryHistory(detail.changes, memory, names, scope) : []
    const usage = usageByConversation((usageQuery.data?.pages ?? []).flatMap(page => page.items))

    const textCard = memory && (
        <section className={styles.card} aria-label={t('memoryPage.detail.textLabel')} data-testid="memory-card">
            {memory.category && (
                <ul className={styles.chips}><li className={styles.chip}>{memory.category}</li></ul>
            )}
            {editing ? (
                <>
                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="memory-text">{t('memoryPage.detail.textLabel')}</label>
                        <textarea
                            id="memory-text"
                            className={styles.textArea}
                            value={draft}
                            maxLength={MAX_TEXT_CHARS}
                            onChange={event => setDraft(event.target.value)}
                            ref={focusAtEnd}
                            data-testid="memory-text"
                        />
                        <div className={styles.fieldFoot}>
                            <span>{t('memoryPage.page.kept')}</span>
                            <span className={styles.count}>{draft.length} / {MAX_TEXT_CHARS}</span>
                        </div>
                    </div>
                    <div className={styles.desktopActions}>
                        <PillButton variant="secondary" label={t('memoryPage.page.cancel')} onClick={() => setEditing(false)} disabled={saving} />
                        <PillButton
                            label={saving ? t('memoryPage.detail.saving') : t('memoryPage.detail.save', { next: latest + 1 })}
                            onClick={save}
                            disabled={!canSave || saving}
                            data-testid="memory-save"
                        />
                    </div>
                </>
            ) : (
                <>
                    <p className={styles.bigText} data-testid="memory-text-shown">{shownText}</p>
                    <div className={styles.cardFoot}>
                        <span className={styles.footNote}>
                            <strong>{t('memoryPage.versions.version', { version: shownVersion })}</strong>
                            {shownChange ? ` · ${formatServerDateOnly(shownChange.createdAt)}` : ''}
                        </span>
                        <PillButton
                            variant={older ? 'primary' : 'secondary'}
                            label={older ? t('memoryPage.page.restore', { next: latest + 1 }) : t('memoryPage.page.edit')}
                            onClick={startEdit}
                            data-testid="memory-edit"
                        />
                    </div>
                </>
            )}
        </section>
    )

    const olderBanner = older && (
        <div className={styles.banner} role="status" data-testid="memory-older">
            <span>{t('memoryPage.page.olderBanner', { version: shownVersion, latest })}</span>
            <Link className={styles.bannerLink} to={latestPath}>{t('memoryPage.page.backToLatest')}</Link>
        </div>
    )

    const timeline = (
        <Timeline
            entries={history}
            label={t('memoryPage.page.history')}
            untitled={t('memoryPage.changes.untitledConversation')}
            deleted={t('memoryPage.changes.deletedConversation')}
        />
    )

    return (
        <DetailShell
            narrow={isNarrow}
            swipeBack={{ to: listPath }}
            title={t('memoryPage.page.title')}
            subtitle={scope ? scopeTitle(scope, names) : undefined}
            menuItems={menuItems}
            menuTitle={t('memoryPage.title')}
            menuContent={(
                <MemoryMenuContent
                    scope={null}
                    counts={counts}
                    projects={projects}
                    projectsLoading={projectsQuery.isPending}
                    projectsFailed={projectsQuery.isError}
                    onClose={() => setLeftSidebarExpanded(false)}
                />
            )}
            breadcrumbs={[
                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                ...(scope ? [{ label: scopeTitle(scope, names), onClick: () => navigate(listPath) }] : []),
                { label: memory ? truncate(memory.text) : t('memoryPage.page.title') },
            ]}
            actions={memory && from ? (
                <>
                    <PillButton
                        label={t('memoryPage.list.moveTo')}
                        icon={ICONS.FOLDER}
                        className={pageHeaderStyles.actionButton}
                        onClick={() => setDialog('move')}
                        data-testid="memory-detail-move"
                    />
                    <MoreMenu
                        label={t('memoryPage.page.more')}
                        items={[
                            ...(from.projectId ? [{ label: t('memoryPage.list.copyToProject'), onSelect: () => setDialog('copy'), testId: 'memory-detail-copy' }] : []),
                            { label: t('memoryPage.list.delete'), onSelect: () => setDialog('delete'), danger: true, testId: 'memory-detail-delete' },
                        ]}
                    />
                </>
            ) : undefined}
            data-testid="memory-detail"
        >
            {detailQuery.isPending && (
                <div className={styles.state}><span>{t('memoryPage.list.loading')}</span></div>
            )}
            {detailQuery.isError && (
                <div className={styles.state} data-testid="memory-detail-error">
                    <p>{t(notFound ? 'memoryPage.detail.notFound' : 'memoryPage.detail.loadFailed')}</p>
                    <PillButton variant="secondary" label={t('memoryPage.detail.backToList')} onClick={() => navigate(listPath)} />
                </div>
            )}
            {memory && detail && from && (isNarrow ? (
                <>
                    {olderBanner}
                    {textCard}
                    <DetailRows
                        label={t('memoryPage.page.rows')}
                        rows={[
                            {
                                key: 'applies',
                                icon: from.projectId ? ICONS.FOLDER : ICONS.BRAIN,
                                accent: true,
                                title: t('memoryPage.page.appliesTo'),
                                summary: memory.placements.map(p => appliesLabel(p, names)).join(', '),
                                onClick: () => setDialog('move'),
                            },
                            {
                                key: 'usage',
                                icon: ICONS.CHAT_BUBBLE,
                                title: t('memoryPage.page.usage'),
                                summary: usageSummary(memory),
                                to: memorySubPath(memory.memoryId, '/usage', scope),
                            },
                            {
                                key: 'history',
                                icon: ICONS.HISTORY,
                                title: t('memoryPage.page.history'),
                                summary: t('memoryPage.page.historySummary', { version: latest, count: detail.changes.length }),
                                to: memorySubPath(memory.memoryId, '/history', scope),
                            },
                        ]}
                    />
                </>
            ) : (
                <DetailColumns
                    main={(
                        <>
                            {olderBanner}
                            {textCard}
                            <section aria-label={t('memoryPage.page.history')} className={styles.field}>
                                <h2 className={styles.sectionTitle}>{t('memoryPage.page.history')}</h2>
                                {timeline}
                            </section>
                        </>
                    )}
                    side={(
                        <>
                            <SideCard title={t('memoryPage.page.appliesTo')} data-testid="memory-applies">
                                <ul className={styles.chips}>
                                    {memory.placements.map(p => (
                                        <li key={p.projectId ?? 'profile'} className={`${styles.chip} ${styles.chipAccent}`}>{appliesLabel(p, names)}</li>
                                    ))}
                                </ul>
                                <PillButton variant="secondary" label={t('memoryPage.page.changeWhere')} onClick={() => setDialog('move')} />
                            </SideCard>
                            <SideCard title={t('memoryPage.page.usage')} data-testid="memory-usage">
                                <UsageStats
                                    stats={[
                                        { value: memory.hitCount, label: t('memoryPage.page.repliesUsedIt') },
                                        { value: memory.lastUsedAt ? formatServerDateOnly(memory.lastUsedAt) : t('memoryPage.page.neverShort'), label: lastUsedLabel(memory) },
                                    ]}
                                />
                                {usage.length > 0 && (
                                    <ConversationList
                                        plain
                                        items={usage.slice(0, SIDE_CONVERSATIONS)}
                                        label={t('memoryPage.page.usedIn')}
                                        untitled={t('memoryPage.changes.untitledConversation')}
                                        deleted={t('memoryPage.changes.deletedConversation')}
                                    />
                                )}
                                {memory.hitCount > 0 && (
                                    <Link className={styles.viewLink} to={memorySubPath(memory.memoryId, '/usage', scope)}>
                                        {t('memoryPage.page.seeAllUsage')}
                                    </Link>
                                )}
                            </SideCard>
                        </>
                    )}
                />
            ))}

            {memory && from && (dialog === 'move' || dialog === 'copy') && (
                <MoveMemoryDialog
                    memory={memory}
                    initialMode={dialog}
                    from={from}
                    projects={projects}
                    onClose={() => setDialog(null)}
                    onDone={updated => {
                        if (scope && !placementIn(updated, scope)) navigate(memoryPath(updated.memoryId, scopeOf(updated)), { replace: true })
                    }}
                />
            )}
            {memory && from && dialog === 'delete' && (
                <DeleteMemoryDialog memory={memory} from={from} onClose={() => setDialog(null)} onDone={() => navigate(listPath)} />
            )}
        </DetailShell>
    )
}

function truncate(text: string, max = 48): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
