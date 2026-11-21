import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
    Grid,
    GridCol,
    PageHeader,
    PillButton,
    ResizableSidebar,
    ScrollArea,
} from '@genflowly/component-library'
import Navbar from '../../components/navbar/Navbar'
import MobileHeader from '../../components/widgets/MobileHeader/MobileHeader'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useResponsiveBreakpoints } from '../../hooks/useResponsiveBreakpoints'
import { useMemories, useProjects } from '../../hooks/queries/useMemories'
import { ICONS } from '../../constants/icons'
import {
    CustomerMemory,
    MemoryPlacement,
    MemoryScope,
    memoriesIn,
    memoryCounts,
    placementIn,
    scopeFromParam,
    scopeToParam,
} from '../../models/memory.models'
import MemoryScopePanels from './components/MemoryScopePanels'
import MemoryMenuContent from './components/MemoryMenuContent'
import MemoryCard, { memoryActions } from './components/MemoryCard'
import MemoryActionsSheet from './components/MemoryActionsSheet'
import MoveMemoryDialog from './components/MoveMemoryDialog'
import DeleteMemoryDialog from './components/DeleteMemoryDialog'
import { placementLabel, projectNames, scopeSubtitle, scopeTitle } from './memoryLabels'
import styles from './MemoryPage.module.scss'

const SIDEBAR_WIDTH_STORAGE_KEY = 'memory_sidebar_width_rem'

type Dialog = {
    type: 'move' | 'copy' | 'delete' | 'sheet'
    memory: CustomerMemory
    from: MemoryPlacement
}

export function memoryPath(memoryId: string, scope?: MemoryScope): string {
    const path = `/memory/${encodeURIComponent(memoryId)}`
    return scope ? `${path}?scope=${encodeURIComponent(scopeToParam(scope))}` : path
}

/**
 * The Memory page: one list at a time — Profile Core, Profile Episodic or a
 * project — chosen in the sidebar (desktop) or the L2 Menu (phones).
 */
export default function MemoryPage(): React.ReactElement {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [params] = useSearchParams()
    const scope = scopeFromParam(params.get('scope'))
    const scopeParam = scopeToParam(scope)
    const { isNarrow } = useResponsiveBreakpoints()
    const { setLeftSidebarExpanded, setRightSidebarExpanded } = useLayout()
    usePageTitle()

    const memoriesQuery = useMemories()
    const projectsQuery = useProjects()
    const memories = useMemo(() => memoriesQuery.data ?? [], [memoriesQuery.data])
    const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
    const names = useMemo(() => projectNames(projects), [projects])
    const counts = useMemo(() => memoryCounts(memories), [memories])
    const list = useMemo(() => memoriesIn(memories, scope), [memories, scope])
    const [dialog, setDialog] = useState<Dialog | null>(null)

    useEffect(() => {
        setLeftSidebarExpanded(false)
        setRightSidebarExpanded(false)
    }, [setLeftSidebarExpanded, setRightSidebarExpanded])

    const title = scopeTitle(scope, names)
    const subtitle = scopeSubtitle(scope)
    const addMemory = () => navigate(`/memory/new?scope=${encodeURIComponent(scopeParam)}`)
    const openScope = (next: MemoryScope) => navigate(`/memory?scope=${encodeURIComponent(scopeToParam(next))}`)
    const loading = memoriesQuery.isPending && memories.length === 0
    const failed = memoriesQuery.isError && memories.length === 0

    const actionsFor = (memory: CustomerMemory, from: MemoryPlacement) => memoryActions(from, {
        edit: () => navigate(memoryPath(memory.memoryId, scope)),
        move: () => setDialog({ type: 'move', memory, from }),
        copy: () => setDialog({ type: 'copy', memory, from }),
        remove: () => setDialog({ type: 'delete', memory, from }),
    }, t)

    return (
        <div className={styles.page}>
            {isNarrow ? (
                <MobileHeader
                    title={title}
                    subtitle={subtitle}
                    menuItems={[{ label: t('memoryPage.list.addMemory'), onClick: addMemory, 'data-testid': 'add-memory-button' }]}
                    menuTitle={t('memoryPage.title')}
                    menuAction={{
                        label: t('memoryPage.list.addMemory'),
                        icon: ICONS.PLUS,
                        onClick: () => {
                            setLeftSidebarExpanded(false)
                            addMemory()
                        },
                        'data-testid': 'menu-add-memory-button',
                    }}
                    menuContent={(
                        <MemoryMenuContent
                            scope={scope}
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
                    <PageHeader
                        title={title}
                        subtitle={subtitle}
                        actions={
                            <PillButton
                                label={t('memoryPage.list.addMemory')}
                                icon={ICONS.PLUS}
                                variant="primary"
                                onClick={addMemory}
                                data-testid="add-memory-button"
                            />
                        }
                        data-testid="memory-page-header"
                    />
                </>
            )}

            <div className={styles.layout}>
                {!isNarrow && (
                    <ResizableSidebar
                        storageKey={SIDEBAR_WIDTH_STORAGE_KEY}
                        minWidth={200}
                        defaultWidth={272}
                        maxWidth={380}
                        data-testid="memory-sidebar"
                    >
                        <MemoryScopePanels
                            scope={scope}
                            counts={counts}
                            projects={projects}
                            isLoading={projectsQuery.isPending}
                            hasError={projectsQuery.isError}
                            onSelect={openScope}
                        />
                    </ResizableSidebar>
                )}

                <ScrollArea className={styles.main} data-testid="memory-list">
                    {loading && (
                        <div className={styles.stateContainer}>
                            <div className={styles.spinner} aria-label={t('memoryPage.list.loading')} />
                        </div>
                    )}

                    {failed && (
                        <div className={styles.stateContainer}>
                            <p className={styles.stateText}>{t('memoryPage.list.loadFailed')}</p>
                            <PillButton
                                variant="secondary"
                                label={t('memoryPage.list.retry')}
                                onClick={() => memoriesQuery.refetch()}
                                data-testid="memory-list-retry"
                            />
                        </div>
                    )}

                    {!loading && !failed && list.length === 0 && (
                        <div className={styles.stateContainer} data-testid="memory-list-empty">
                            <p className={styles.stateText}>
                                {t(scope.type === 'project' ? 'memoryPage.list.emptyProjectTitle' : 'memoryPage.list.emptyProfileTitle')}
                            </p>
                            <p className={styles.stateSubText}>
                                {t(scope.type === 'project' ? 'memoryPage.list.emptyProjectText' : 'memoryPage.list.emptyProfileText')}
                            </p>
                        </div>
                    )}

                    {list.length > 0 && (
                        <Grid>
                            {list.map(memory => {
                                const from = placementIn(memory, scope)!
                                return (
                                    <GridCol key={memory.memoryId} span={12} md={6} lg={4}>
                                        <MemoryCard
                                            memory={memory}
                                            placement={from}
                                            actions={actionsFor(memory, from)}
                                            onOpen={() => navigate(memoryPath(memory.memoryId, scope))}
                                            onShowActions={isNarrow ? () => setDialog({ type: 'sheet', memory, from }) : undefined}
                                        />
                                    </GridCol>
                                )
                            })}
                        </Grid>
                    )}
                </ScrollArea>
            </div>

            {dialog?.type === 'sheet' && (
                <MemoryActionsSheet
                    memory={dialog.memory}
                    summary={[
                        placementLabel(dialog.from, names),
                        t('memoryPage.list.usedSummary', { count: dialog.memory.hitCount }),
                        t('memoryPage.list.versionSummary', { version: dialog.memory.version }),
                    ].join(' · ')}
                    actions={actionsFor(dialog.memory, dialog.from)}
                    onClose={() => setDialog(null)}
                />
            )}
            {(dialog?.type === 'move' || dialog?.type === 'copy') && (
                <MoveMemoryDialog
                    memory={dialog.memory}
                    initialMode={dialog.type}
                    from={dialog.from}
                    projects={projects}
                    onClose={() => setDialog(null)}
                />
            )}
            {dialog?.type === 'delete' && (
                <DeleteMemoryDialog memory={dialog.memory} from={dialog.from} onClose={() => setDialog(null)} />
            )}
        </div>
    )
}
