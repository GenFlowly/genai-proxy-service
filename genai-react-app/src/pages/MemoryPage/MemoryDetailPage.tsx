import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
    Breadcrumbs,
    PillButton,
    ResizableSidebar,
    ScrollArea,
    SidebarListPanel,
    pageHeaderStyles,
} from '@genflowly/component-library'
import type { SidebarListGroup } from '@genflowly/component-library'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import { useAuth } from '../../context/AuthContext'
import { useLayout } from '../../context/LayoutContext'
import { useToast } from '../../context/ToastContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useMemories, useMemoryDetail, useMemoryUsage, useProjects } from '../../hooks/queries/useMemories'
import {
    CustomerMemory,
    MemoryScope,
    memoryCounts,
    placementIn,
    scopeFromParam,
    scopeToParam,
} from '../../models/memory.models'
import { MemoryApiError, editMemory } from '../../services/memoriesService'
import { formatServerDateTime } from '../../utils/timeUtils'
import MemoryMenuContent from './components/MemoryMenuContent'
import MoveMemoryDialog from './components/MoveMemoryDialog'
import DeleteMemoryDialog from './components/DeleteMemoryDialog'
import { MemoryChangeLog, MemoryUsageLog } from './components/MemoryLogs'
import { changeTitle, placementLabel, projectNames, scopeTitle } from './memoryLabels'
import { memoryPath } from './MemoryPage'
import styles from './MemoryPage.module.scss'

const VERSIONS_WIDTH_STORAGE_KEY = 'memory_versions_width_rem'
const MAX_TEXT_CHARS = 500

function scopeOf(memory: CustomerMemory): MemoryScope {
    const first = memory.placements[0]
    if (first?.projectId) return { type: 'project', projectId: first.projectId }
    return { type: 'profile', kind: first?.kind ?? memory.kind }
}

/**
 * One memory: its text (every save is a new version; old versions never
 * change), its versions, the change log saying what caused each change, and
 * the usage log of the replies it was used in.
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
    const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
    const names = useMemo(() => projectNames(projects), [projects])
    const counts = useMemo(() => memoryCounts(memoriesQuery.data ?? []), [memoriesQuery.data])
    const detail = detailQuery.data
    const memory = detail?.memory

    const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
    const [draft, setDraft] = useState<string | null>(null)
    const [tab, setTab] = useState<'changes' | 'usage'>('changes')
    const [saving, setSaving] = useState(false)
    const [versionsOpen, setVersionsOpen] = useState(false)
    const [dialog, setDialog] = useState<'move' | 'copy' | 'delete' | null>(null)
    const usageQuery = useMemoryUsage(memoryId, tab === 'usage')

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    useEffect(() => {
        setSelectedVersion(null)
        setDraft(null)
    }, [memoryId])

    const requested = params.get('scope') ? scopeFromParam(params.get('scope')) : null
    const scope: MemoryScope | null = memory
        ? (requested && placementIn(memory, requested) ? requested : scopeOf(memory))
        : requested
    const from = memory && scope ? placementIn(memory, scope) ?? memory.placements[0] : undefined
    const latestVersion = memory?.version ?? 1
    const shownVersion = selectedVersion ?? latestVersion
    const versionText = detail?.versions.find(v => v.version === shownVersion)?.text ?? memory?.text ?? ''
    const text = draft ?? versionText
    const nextVersion = latestVersion + 1
    const trimmed = text.trim()
    const canSave = !!memory && trimmed.length > 0 && trimmed.length <= MAX_TEXT_CHARS && trimmed !== memory.text
    const listPath = scope ? `/memory?scope=${encodeURIComponent(scopeToParam(scope))}` : '/memory'
    const notFound = detailQuery.error instanceof MemoryApiError && detailQuery.error.status === 404

    const save = async () => {
        if (!memory || !canSave) return
        setSaving(true)
        try {
            const updated = await editMemory(await getAccessTokenSilently(), memory.memoryId, trimmed, memory.version)
            showToast(t('memoryPage.detail.saved', { version: updated.version }))
            setSelectedVersion(null)
            setDraft(null)
        } catch (error) {
            console.error('Failed to save memory:', error)
            const conflict = error instanceof MemoryApiError && error.status === 409
            showToast(t(conflict ? 'memoryPage.detail.conflict' : 'memoryPage.detail.saveFailed'))
            if (conflict) detailQuery.refetch()
        } finally {
            setSaving(false)
        }
    }

    const versionsGroup: SidebarListGroup = {
        id: 'versions',
        label: '',
        items: (detail?.versions ?? []).map(version => ({
            id: String(version.version),
            label: (
                <span className={styles.versionRow}>
                    {t('memoryPage.versions.version', { version: version.version })}
                    {version.version === latestVersion && <span className={styles.versionBadge}>{t('memoryPage.versions.latest')}</span>}
                </span>
            ),
            details: (
                <span className={styles.versionDetails}>
                    {changeTitle(version)} · {formatServerDateTime(version.createdAt)}
                </span>
            ),
            isActive: version.version === shownVersion,
            ariaCurrent: 'true' as const,
            onSelect: () => {
                setSelectedVersion(version.version === latestVersion ? null : version.version ?? null)
                setDraft(null)
                setVersionsOpen(false)
            },
            testId: `memory-version-${version.version}`,
        })),
    }

    const versionsPanel = (
        <SidebarListPanel
            title={t('memoryPage.versions.title')}
            groups={[versionsGroup]}
            isLoading={detailQuery.isPending}
            hasError={false}
            errorText=""
            emptyText=""
            listAriaLabel={t('memoryPage.versions.title')}
            data-testid="memory-versions"
        />
    )

    const menuItems = memory && from ? [
        { label: t('memoryPage.list.moveTo'), onClick: () => setDialog('move'), 'data-testid': 'memory-detail-move' },
        ...(from.projectId ? [{ label: t('memoryPage.list.copyToProject'), onClick: () => setDialog('copy'), 'data-testid': 'memory-detail-copy' }] : []),
        { label: t('memoryPage.list.delete'), onClick: () => setDialog('delete'), 'data-testid': 'memory-detail-delete' },
    ] : undefined

    return (
        <div className={styles.page}>
            {isNarrow ? (
                <MobileHeader
                    title={t('memoryPage.detail.editMemory')}
                    subtitle={from ? placementLabel(from, names) : undefined}
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
                />
            ) : (
                <>
                    <Navbar />
                    <div className={pageHeaderStyles.header}>
                        <Breadcrumbs
                            variant="onHeader"
                            items={[
                                { label: t('memoryPage.title'), onClick: () => navigate('/memory') },
                                ...(scope ? [{ label: scopeTitle(scope, names), onClick: () => navigate(listPath) }] : []),
                                { label: t('memoryPage.detail.editMemory') },
                            ]}
                        />
                        {memory && from && (
                            <div className={pageHeaderStyles.actions}>
                                <PillButton
                                    variant="secondary"
                                    label={t('memoryPage.list.moveTo')}
                                    className={pageHeaderStyles.actionButton}
                                    onClick={() => setDialog('move')}
                                    data-testid="memory-detail-move"
                                />
                                {from.projectId && (
                                    <PillButton
                                        variant="secondary"
                                        label={t('memoryPage.list.copyToProject')}
                                        className={pageHeaderStyles.actionButton}
                                        onClick={() => setDialog('copy')}
                                        data-testid="memory-detail-copy"
                                    />
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}

            <div className={styles.layout}>
                {!isNarrow && memory && (
                    <ResizableSidebar
                        storageKey={VERSIONS_WIDTH_STORAGE_KEY}
                        minWidth={200}
                        defaultWidth={280}
                        maxWidth={380}
                        data-testid="memory-versions-sidebar"
                    >
                        {versionsPanel}
                    </ResizableSidebar>
                )}

                <ScrollArea className={styles.main} data-testid="memory-detail">
                    {detailQuery.isPending && (
                        <div className={styles.stateContainer}>
                            <div className={styles.spinner} aria-label={t('memoryPage.list.loading')} />
                        </div>
                    )}

                    {detailQuery.isError && (
                        <div className={styles.stateContainer} data-testid="memory-detail-error">
                            <p className={styles.stateText}>
                                {t(notFound ? 'memoryPage.detail.notFound' : 'memoryPage.detail.loadFailed')}
                            </p>
                            <PillButton variant="secondary" label={t('memoryPage.detail.backToList')} onClick={() => navigate(listPath)} />
                        </div>
                    )}

                    {memory && detail && (
                        <div className={styles.detail}>
                            {isNarrow && (
                                <div className={styles.versionsToggle}>
                                    <button
                                        type="button"
                                        className={styles.versionsToggleButton}
                                        aria-expanded={versionsOpen}
                                        onClick={() => setVersionsOpen(open => !open)}
                                        data-testid="memory-versions-toggle"
                                    >
                                        <span className={styles.fieldLabel}>{t('memoryPage.versions.title')}</span>
                                        <span>
                                            {t('memoryPage.versions.version', { version: shownVersion })}
                                            {shownVersion === latestVersion ? ` · ${t('memoryPage.versions.latest')}` : ''}
                                        </span>
                                    </button>
                                    {versionsOpen && versionsPanel}
                                </div>
                            )}

                            <div className={styles.metaRow}>
                                <span className={styles.muted}>{t('memoryPage.detail.appliesIn')}</span>
                                {memory.placements.map(placement => (
                                    <span key={placement.projectId ?? 'profile'} className={`${styles.tag} ${styles.tagKind}`}>
                                        {placementLabel(placement, names)}
                                    </span>
                                ))}
                                {memory.category && <span className={styles.tag}>{memory.category}</span>}
                                <span className={styles.spacer} />
                                <span className={styles.muted}>
                                    {memory.hitCount > 0
                                        ? t('memoryPage.detail.usedSummary', {
                                            count: memory.hitCount,
                                            date: memory.lastUsedAt ? formatServerDateTime(memory.lastUsedAt) : '',
                                        })
                                        : t('memoryPage.detail.neverUsed')}
                                </span>
                            </div>

                            <div className={styles.field}>
                                <label className={styles.fieldLabel} htmlFor="memory-text">{t('memoryPage.detail.textLabel')}</label>
                                <textarea
                                    id="memory-text"
                                    className={styles.textArea}
                                    value={text}
                                    maxLength={MAX_TEXT_CHARS}
                                    onChange={event => setDraft(event.target.value)}
                                    spellCheck={false}
                                    data-testid="memory-text"
                                />
                                <p className={styles.help}>
                                    {shownVersion === latestVersion
                                        ? t('memoryPage.detail.hintLatest', { next: nextVersion })
                                        : t('memoryPage.detail.hintOld', { version: shownVersion, next: nextVersion })}
                                </p>
                            </div>

                            <div className={styles.detailActions}>
                                <PillButton
                                    variant="danger"
                                    label={t('memoryPage.list.delete')}
                                    onClick={() => setDialog('delete')}
                                    disabled={saving}
                                    data-testid="memory-detail-delete-button"
                                />
                                <PillButton
                                    label={saving ? t('memoryPage.detail.saving') : t('memoryPage.detail.save', { next: nextVersion })}
                                    onClick={save}
                                    disabled={!canSave || saving}
                                    data-testid="memory-save"
                                />
                            </div>

                            <div className={styles.tabs} role="tablist" aria-label={t('memoryPage.detail.logs')}>
                                {([
                                    ['changes', t('memoryPage.detail.changeLog'), detail.changes.length],
                                    ['usage', t('memoryPage.detail.usageLog'), memory.hitCount],
                                ] as const).map(([id, label, count]) => (
                                    <button
                                        key={id}
                                        type="button"
                                        role="tab"
                                        aria-selected={tab === id}
                                        className={`${styles.tab} ${tab === id ? styles.tabOn : ''}`}
                                        onClick={() => setTab(id)}
                                        data-testid={`memory-tab-${id}`}
                                    >
                                        {label}
                                        <span className={styles.scopeCount}>{count}</span>
                                    </button>
                                ))}
                            </div>

                            {tab === 'changes' ? (
                                <MemoryChangeLog changes={detail.changes} names={names} selectedVersion={shownVersion} />
                            ) : (
                                <MemoryUsageLog
                                    pages={usageQuery.data?.pages ?? []}
                                    total={memory.hitCount}
                                    isLoading={usageQuery.isPending}
                                    isError={usageQuery.isError}
                                    hasMore={!!usageQuery.hasNextPage}
                                    loadingMore={usageQuery.isFetchingNextPage}
                                    onLoadMore={() => usageQuery.fetchNextPage()}
                                />
                            )}
                        </div>
                    )}
                </ScrollArea>
            </div>

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
                <DeleteMemoryDialog
                    memory={memory}
                    from={from}
                    onClose={() => setDialog(null)}
                    onDone={() => navigate(listPath)}
                />
            )}
        </div>
    )
}
