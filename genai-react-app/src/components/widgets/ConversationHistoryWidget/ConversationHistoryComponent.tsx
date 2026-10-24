import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { useToast } from '../../../context/ToastContext'
import {
    getCustomerConversations,
    getPinnedConversations,
    archiveConversation,
    pinConversation,
    unpinConversation,
    getProjects,
    createProject,
    assignConversationToProject,
    unassignConversationFromProject,
} from '../../../services/conversationHistoryService'
import { ConversationSummary, ForkConversationResponse, Project } from '../../../models/conversationHistory.models'
import { CollapsedVendorBrandName } from '../../common/BrandName/BrandName'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { CONVERSATION_FORKED_EVENT } from '../../../constants/events'
import { SidebarListPanel, SidebarListGroup, SidebarListItem, SidebarListLoadMore, Modal, InputTextWithHint, VerticalSplit } from '@genflowly/component-library'
import { sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import styles from './ConversationHistory.module.scss'
import { loadHistoryCache, saveHistoryCache, getExpandedProject, setExpandedProject } from './historyCache'
import { formatServerDateTime, formatServerTime, parseServerDate } from '../../../utils/timeUtils'

const PAGE_SIZE = 15

// Top (Projects) pane's share of the sidebar height, persisted as a fraction
// so both panes keep scaling together when the sidebar resizes
const HISTORY_SPLIT_STORAGE_KEY = 'conversation_history_split_fraction'

// One entry in the Projects section: the project's own pinned and recent
// conversations, rendered as subsections under a collapsible project row
interface ProjectBucket {
    id: string
    name: string
    pinned: ConversationSummary[]
    recent: ConversationSummary[]
}

export default function ConversationHistoryComponent() {
    const { t } = useTranslation()
    const { getAccessTokenSilently, isAuthenticated, customerId } = useAuth()
    const { conversationId, conversationTitle, pendingProjectId, startConversationInProject } = useConversation()
    const { showToast } = useToast()
    const navigate = useNavigate()
    const { conversationId: activeId } = useParams<{ conversationId: string }>()

    // Stale-while-revalidate: paint the last known list immediately (if any),
    // then refresh from the API in the background
    const cached = useMemo(() => loadHistoryCache(customerId), [customerId])
    const [items, setItems] = useState<ConversationSummary[]>(cached?.items ?? [])
    const [pinned, setPinned] = useState<ConversationSummary[]>(cached?.pinned ?? [])
    const [lastKey, setLastKey] = useState<string | null>(cached?.lastKey ?? null)
    const [isLoading, setIsLoading] = useState(false)
    const [hasMore, setHasMore] = useState(!!cached?.hasMore)
    const [error, setError] = useState(false)
    const [projects, setProjects] = useState<Project[]>(cached?.projects ?? [])

    // Project dialogs: the create form, and the conversation a
    // "Move to project" picker is currently open for
    const [isCreateProjectOpen, setCreateProjectOpen] = useState(false)
    const [newProjectName, setNewProjectName] = useState('')
    const [isCreatingProject, setIsCreatingProject] = useState(false)
    const [moveTarget, setMoveTarget] = useState<ConversationSummary | null>(null)

    // The library's collapsible groups are uncontrolled (defaultExpanded is
    // read on mount), so force-expanding a project when a conversation is
    // started inside it works by bumping the group's id: the remounted group
    // re-reads the session expansion memory
    const [expandEpochs, setExpandEpochs] = useState<Record<string, number>>({})

    // Only persist state to the cache once a real load has happened, so an
    // empty "never loaded" state can't masquerade as "no conversations"
    const hasLoadedRef = React.useRef(!!cached)

    const fetchPage = useCallback(async (startKey?: string | null) => {
        if (!isAuthenticated) return
        setIsLoading(true)
        setError(false)
        try {
            const token = await getAccessTokenSilently()
            const resp = await getCustomerConversations(token, PAGE_SIZE, startKey)
            hasLoadedRef.current = true
            setItems(prev => startKey ? [...prev, ...resp.conversations] : resp.conversations)
            setLastKey(resp.lastEvaluatedKey)
            setHasMore(!!resp.lastEvaluatedKey)
        } catch {
            setError(true)
        } finally {
            setIsLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently])

    // The pinned list has no pagination; the server is the source of truth for
    // which conversations belong in the Pinned section
    const fetchPinned = useCallback(async () => {
        if (!isAuthenticated) return
        try {
            const token = await getAccessTokenSilently()
            const resp = await getPinnedConversations(token)
            setPinned(resp.conversations)
        } catch {
            // Keep whatever pinned state we already have (cache or optimistic);
            // a failed pinned refresh must not take down the history list
        }
    }, [isAuthenticated, getAccessTokenSilently])

    // The user's projects; they render in the Projects section even while
    // empty, so a project is visible from the moment it is created
    const fetchProjects = useCallback(async () => {
        if (!isAuthenticated) return
        try {
            const token = await getAccessTokenSilently()
            const resp = await getProjects(token)
            setProjects(resp.projects)
        } catch {
            // Keep whatever projects state we already have; a failed projects
            // refresh must not take down the history list
        }
    }, [isAuthenticated, getAccessTokenSilently])

    // Load first page on mount / auth change (background refresh when cached)
    useEffect(() => {
        fetchPage(null)
        fetchPinned()
        fetchProjects()
    }, [fetchPage, fetchPinned, fetchProjects])

    // Mirror every loaded/mutated state (fetch, archive, pin, title patch) to
    // the cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveHistoryCache(customerId, { items, pinned, lastKey, hasMore, projects })
    }, [customerId, items, pinned, lastKey, hasMore, projects])

    // Patch title in list when the active conversation gets a generated title
    useEffect(() => {
        if (!conversationId || !conversationTitle) return
        setItems(prev => {
            const idx = prev.findIndex(c => c.conversationId === conversationId)
            if (idx === -1) {
                // Conversation not yet in list (e.g. brand new) — prepend it.
                // One started inside a project (message+ on the project row)
                // is stamped with it so it groups there immediately instead
                // of flashing in Recents until the next server fetch
                return [{
                    conversationId,
                    title: conversationTitle,
                    createdAt: null,
                    updatedAt: null,
                    projectId: pendingProjectId ?? undefined,
                    projectName: pendingProjectId
                        ? projects.find(p => p.projectId === pendingProjectId)?.name
                        : undefined,
                }, ...prev]
            }
            if (prev[idx].title === conversationTitle) return prev
            const next = [...prev]
            next[idx] = { ...next[idx], title: conversationTitle }
            return next
        })
        setPinned(prev => {
            const idx = prev.findIndex(c => c.conversationId === conversationId)
            if (idx === -1 || prev[idx].title === conversationTitle) return prev
            const next = [...prev]
            next[idx] = { ...next[idx], title: conversationTitle }
            return next
        })
    }, [conversationId, conversationTitle, pendingProjectId, projects])

    // Insert a fork the moment it is created (ConversationContext announces it
    // right before navigating there): the list is only fetched on mount, and
    // the title-patch effect above doesn't know the parent, so without this
    // the fork would render flat at the top instead of nested under its parent
    useEffect(() => {
        const onForked = (e: Event) => {
            const fork = (e as CustomEvent<ForkConversationResponse>).detail
            if (!fork?.conversationId) return
            const now = new Date().toISOString()
            const summary: ConversationSummary = {
                conversationId: fork.conversationId,
                title: fork.title,
                createdAt: fork.createdAt ?? now,
                updatedAt: fork.updatedAt ?? now,
                pinnedAt: fork.pinnedAt ?? undefined,
                projectId: fork.projectId ?? undefined,
                projectName: fork.projectId
                    ? projects.find(p => p.projectId === fork.projectId)?.name
                    : undefined,
                parentConversationId: fork.parentConversationId,
            }
            setItems(prev => [summary, ...prev.filter(c => c.conversationId !== summary.conversationId)])
            if (summary.pinnedAt) {
                setPinned(prev => [summary, ...prev.filter(c => c.conversationId !== summary.conversationId)])
            }
        }
        window.addEventListener(CONVERSATION_FORKED_EVENT, onForked)
        return () => window.removeEventListener(CONVERSATION_FORKED_EVENT, onForked)
    }, [projects])

    const handleLoadMore = () => fetchPage(lastKey)

    const handleNavigate = (convId: string) => {
        navigate(`/chat/${convId}`)
    }

    const handleArchive = async (e: React.MouseEvent, convId: string) => {
        e.stopPropagation()
        try {
            const token = await getAccessTokenSilently()
            await archiveConversation(token, convId)
            setItems(prev => prev.filter(c => c.conversationId !== convId))
            // The pinned endpoint excludes archived conversations, so drop it locally too
            setPinned(prev => prev.filter(c => c.conversationId !== convId))
            // If the archived conversation is currently active, navigate away
            if (convId === activeId) {
                navigate('/chat')
            }
        } catch (err) {
            console.error('Failed to archive conversation:', err)
        }
    }

    const handlePin = async (e: React.MouseEvent, conv: ConversationSummary) => {
        e.stopPropagation()
        // Optimistic: surface it in the Pinned section right away; the item
        // stays in `items` and is excluded from the date groups while pinned
        setPinned(prev => [
            { ...conv, pinnedAt: new Date().toISOString() },
            ...prev.filter(c => c.conversationId !== conv.conversationId),
        ])
        try {
            const token = await getAccessTokenSilently()
            await pinConversation(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.pinnedToast'))
        } catch (err) {
            console.error('Failed to pin conversation:', err)
            setPinned(prev => prev.filter(c => c.conversationId !== conv.conversationId))
            showToast(t('conversation.conversationHistory.pinFailed'))
        }
    }

    const handleUnpin = async (e: React.MouseEvent, conv: ConversationSummary) => {
        e.stopPropagation()
        const previousPinned = pinned
        setPinned(prev => prev.filter(c => c.conversationId !== conv.conversationId))
        // A pinned conversation older than the loaded pages may not be in
        // `items` yet — put it back so it lands in the right date group
        setItems(prev => {
            if (prev.some(c => c.conversationId === conv.conversationId)) return prev
            return [...prev, conv].sort((a, b) =>
                (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
            )
        })
        try {
            const token = await getAccessTokenSilently()
            await unpinConversation(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.unpinnedToast'))
        } catch (err) {
            console.error('Failed to unpin conversation:', err)
            setPinned(previousPinned)
            showToast(t('conversation.conversationHistory.unpinFailed'))
        }
    }

    // ─── Projects ────────────────────────────────────────────────────────────

    const applyProjectLocally = (convId: string, projectId: string | null, projectName: string | null) => {
        const patch = (c: ConversationSummary) =>
            c.conversationId === convId ? { ...c, projectId, projectName } : c
        setItems(prev => prev.map(patch))
        setPinned(prev => prev.map(patch))
    }

    const handleCreateProject = async () => {
        const name = newProjectName.trim()
        if (!name || isCreatingProject) return
        setIsCreatingProject(true)
        try {
            const token = await getAccessTokenSilently()
            const project = await createProject(token, name)
            // The server lists most-recently-updated first, so prepend
            setProjects(prev => [project, ...prev])
            setExpandedProject(project.projectId, true)
            setCreateProjectOpen(false)
            setNewProjectName('')
            showToast(t('conversation.conversationHistory.projectCreated'))
        } catch (err) {
            console.error('Failed to create project:', err)
            showToast(t('conversation.conversationHistory.createProjectFailed'))
        } finally {
            setIsCreatingProject(false)
        }
    }

    const handleMoveToProject = async (conv: ConversationSummary, project: Project) => {
        setMoveTarget(null)
        const previous = { projectId: conv.projectId ?? null, projectName: conv.projectName ?? null }
        // Optimistic: regroup immediately; assign overwrites any previous
        // assignment server-side, so this is also the move-between-projects path
        applyProjectLocally(conv.conversationId, project.projectId, project.name)
        setExpandedProject(project.projectId, true)
        try {
            const token = await getAccessTokenSilently()
            await assignConversationToProject(token, conv.conversationId, project.projectId)
            showToast(t('conversation.conversationHistory.movedToProject', { name: project.name }))
        } catch (err) {
            console.error('Failed to move conversation to project:', err)
            applyProjectLocally(conv.conversationId, previous.projectId, previous.projectName)
            showToast(t('conversation.conversationHistory.moveToProjectFailed'))
        }
    }

    const handleRemoveFromProject = async (conv: ConversationSummary) => {
        setMoveTarget(null)
        const previous = { projectId: conv.projectId ?? null, projectName: conv.projectName ?? null }
        applyProjectLocally(conv.conversationId, null, null)
        try {
            const token = await getAccessTokenSilently()
            await unassignConversationFromProject(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.removedFromProject'))
        } catch (err) {
            console.error('Failed to remove conversation from project:', err)
            applyProjectLocally(conv.conversationId, previous.projectId, previous.projectName)
            showToast(t('conversation.conversationHistory.removeFromProjectFailed'))
        }
    }

    // Pinned conversations render only in a Pinned section (global or their
    // project's), never in a Recent section, even though they stay in `items`
    const pinnedIds = useMemo(() => new Set(pinned.map(c => c.conversationId)), [pinned])
    const recentItems = useMemo(
        () => items.filter(c => !pinnedIds.has(c.conversationId)),
        [items, pinnedIds]
    )

    // Conversations carrying a projectId group under their project's entry in
    // the Projects section; the rest fall through to the global sections.
    // Projects keep first-appearance order (pinned before recent, each list
    // already sorted by the server)
    const { projectBuckets, globalPinned, globalRecent } = useMemo(() => {
        const buckets = new Map<string, ProjectBucket>()
        // Every project the user owns gets an entry up front, so freshly
        // created and empty projects are visible; conversations fill them in
        for (const project of projects) {
            buckets.set(project.projectId, { id: project.projectId, name: project.name, pinned: [], recent: [] })
        }
        const bucketFor = (conv: ConversationSummary, projectId: string) => {
            let bucket = buckets.get(projectId)
            if (!bucket) {
                bucket = { id: projectId, name: conv.projectName?.trim() || projectId, pinned: [], recent: [] }
                buckets.set(projectId, bucket)
            }
            return bucket
        }
        const globalPinned: ConversationSummary[] = []
        const globalRecent: ConversationSummary[] = []
        for (const conv of pinned) {
            if (conv.projectId) bucketFor(conv, conv.projectId).pinned.push(conv)
            else globalPinned.push(conv)
        }
        for (const conv of recentItems) {
            if (conv.projectId) bucketFor(conv, conv.projectId).recent.push(conv)
            else globalRecent.push(conv)
        }
        return { projectBuckets: Array.from(buckets.values()), globalPinned, globalRecent }
    }, [pinned, recentItems, projects])

    const isToday = (value: string) => {
        const d = parseServerDate(value)
        if (!d) return false
        const now = new Date()
        return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate()
    }

    const renderDetails = (conv: ConversationSummary) => (
        <>
            <div className={styles.vendorIcons}>
                {[...(conv.vendors || [])].sort().map((v, idx) => (
                    <CollapsedVendorBrandName key={idx} vendorId={v} size={11} className={styles.vendorIcon} />
                ))}
            </div>
            {(conv.vendors?.length ?? 0) > 0 && conv.updatedAt && (
                <span className={panelStyles.detailsSeparator} aria-hidden="true">·</span>
            )}
            {conv.updatedAt && (
                <span className={panelStyles.timestamp}>
                    {isToday(conv.updatedAt)
                        // Same-day conversations don't need the date — time only
                        ? formatServerTime(conv.updatedAt)
                        : formatServerDateTime(conv.updatedAt)}
                </span>
            )}
        </>
    )

    const toRow = (conv: ConversationSummary, isPinned: boolean) => {
        return {
            id: conv.conversationId,
            label: conv.title?.trim() || conv.conversationId,
            details: renderDetails(conv),
            isActive: conv.conversationId === activeId,
            ariaCurrent: 'page' as const,
            onSelect: () => handleNavigate(conv.conversationId),
            testId: `conv-history-item-${conv.conversationId}`,
            actions: [
                {
                    icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.moveToProject'),
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        setMoveTarget(conv)
                    },
                    revealOnHover: true,
                    testId: `conv-move-btn-${conv.conversationId}`,
                },
                {
                    icon: <Icon src={isPinned ? ICONS.PIN_OFF : ICONS.PIN} size={14} aria-hidden={true} />,
                    label: isPinned
                        ? t('conversation.conversationHistory.unpinConversation')
                        : t('conversation.conversationHistory.pinConversation'),
                    onClick: (e: React.MouseEvent) => (isPinned ? handleUnpin(e, conv) : handlePin(e, conv)),
                    revealOnHover: true,
                    testId: `conv-${isPinned ? 'unpin' : 'pin'}-btn-${conv.conversationId}`,
                },
                {
                    icon: <Icon src={ICONS.ARCHIVE} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.archiveConversation'),
                    onClick: (e: React.MouseEvent) => handleArchive(e, conv.conversationId),
                    testId: `conv-archive-btn-${conv.conversationId}`,
                },
            ],
        }
    }

    /**
     * Nest forked conversations under their parent, forming the fork tree the
     * sidebar draws with indent + connector lines. A conversation becomes a
     * child only when its parent renders in the SAME section list (pinned vs
     * recent vs a project's subsection) — otherwise it stays a flat root, so
     * a fork never disappears just because its parent moved elsewhere. Forks
     * of forks nest recursively; parents keep the list's order.
     */
    const toTreeRows = (list: ConversationSummary[], isPinned: boolean): SidebarListItem[] => {
        const idsInList = new Set(list.map(c => c.conversationId))
        const childrenByParent = new Map<string, ConversationSummary[]>()
        const roots: ConversationSummary[] = []
        for (const conv of list) {
            const parentId = conv.parentConversationId
            if (parentId && parentId !== conv.conversationId && idsInList.has(parentId)) {
                childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), conv])
            } else {
                roots.push(conv)
            }
        }
        const build = (conv: ConversationSummary): SidebarListItem => ({
            ...toRow(conv, isPinned),
            children: (childrenByParent.get(conv.conversationId) ?? []).map(build),
        })
        return roots.map(build)
    }

    // A project renders as a collapsible row holding its own Pinned/Recent
    // subsections. First mount expands the project of the active conversation;
    // after that the user's own toggles win for the rest of the session
    // Start a fresh conversation that will be born inside the project on its
    // first message; keep the project open so it is visible once it appears
    const handleNewConversationInProject = (project: ProjectBucket) => {
        setExpandedProject(project.id, true)
        setExpandEpochs(prev => ({ ...prev, [project.id]: (prev[project.id] ?? 0) + 1 }))
        startConversationInProject?.(project.id)
    }

    const toProjectGroup = (project: ProjectBucket): SidebarListGroup => {
        const containsActive =
            !!activeId &&
            [...project.pinned, ...project.recent].some(c => c.conversationId === activeId)
        const expandEpoch = expandEpochs[project.id]
        return {
            id: expandEpoch ? `project-${project.id}-x${expandEpoch}` : `project-${project.id}`,
            label: project.name,
            collapsible: true,
            defaultExpanded: getExpandedProject(project.id) ?? containsActive,
            icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
            onToggle: expanded => setExpandedProject(project.id, expanded),
            testId: `conv-history-project-${project.id}`,
            actions: [
                {
                    // Always visible (no revealOnHover): starting a chat in a
                    // project is a primary affordance, not a row-management
                    // one. Same plus icon as the app's New Chat button.
                    icon: <Icon src={ICONS.PLUS} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.newConversationInProject'),
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        handleNewConversationInProject(project)
                    },
                    testId: `conv-history-project-new-conv-${project.id}`,
                },
            ],
            groups: [
                ...(project.pinned.length > 0
                    ? [{
                        id: `project-${project.id}-pinned`,
                        label: t('conversation.conversationHistory.pinned'),
                        items: toTreeRows(project.pinned, true),
                    }]
                    : []),
                ...(project.recent.length > 0
                    ? [{
                        id: `project-${project.id}-recent`,
                        label: t('conversation.conversationHistory.recent'),
                        items: toTreeRows(project.recent, false),
                    }]
                    : []),
            ],
        }
    }

    // The Projects panel renders whenever there is anything to show or the
    // first load has settled, so projects are discoverable and creatable right
    // from the sidebar; it only steps aside for the initial skeleton and the
    // nothing-at-all error state
    const hasAnyData = items.length > 0 || pinned.length > 0 || projects.length > 0
    const showProjectsPanel = hasAnyData || (!isLoading && !error)

    // The Projects panel's own library sidebar panel, stacked above History.
    // Creating a project lives in the header as a folder+ icon button
    // (tooltip from its label), so the list itself holds only projects
    const projectsGroups: SidebarListGroup[] = [
        {
            id: 'projects',
            label: t('conversation.conversationHistory.projects'),
            actions: [
                {
                    icon: <Icon src={ICONS.FOLDER_PLUS} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.newProject'),
                    onClick: () => setCreateProjectOpen(true),
                    testId: 'conv-history-new-project',
                },
            ],
            groups: projectBuckets.map(toProjectGroup),
        },
    ]

    // The History panel below it: global Pinned and Recents only; each
    // section is omitted when empty
    const historyGroups: SidebarListGroup[] = [
        ...(globalPinned.length > 0
            ? [{
                id: 'pinned',
                label: t('conversation.conversationHistory.pinned'),
                items: toTreeRows(globalPinned, true),
            }]
            : []),
        ...(globalRecent.length > 0
            ? [{
                id: 'recent',
                label: t('conversation.conversationHistory.recents'),
                items: toTreeRows(globalRecent, false),
            }]
            : []),
    ]

    return (
        <>
            <VerticalSplit
                storageKey={HISTORY_SPLIT_STORAGE_KEY}
                separatorLabel={t('conversation.conversationHistory.resizePanels')}
                handleTestId="history-split-handle"
                topTestId="projects-pane"
                bottomTestId="history-pane"
                top={showProjectsPanel ? (
                    <SidebarListPanel
                        groups={projectsGroups}
                        isLoading={false}
                        hasError={false}
                        errorText={t('conversation.conversationHistory.failedToLoad')}
                        emptyText={t('conversation.conversationHistory.noProjectsYet')}
                        listAriaLabel={t('conversation.conversationHistory.projects')}
                    />
                ) : null}
                bottom={
                    <SidebarListPanel
                        groups={historyGroups}
                        isLoading={isLoading}
                        hasError={error}
                        errorText={t('conversation.conversationHistory.failedToLoad')}
                        emptyText={t('conversation.conversationHistory.noConversationsYet')}
                        listAriaLabel={t('conversation.conversationHistory.listAriaLabel')}
                        footer={hasMore && (
                            <SidebarListLoadMore
                                label={isLoading ? t('conversation.conversationHistory.loading') : t('conversation.conversationHistory.loadMore')}
                                onClick={handleLoadMore}
                                disabled={isLoading}
                                testId="conv-history-load-more"
                            />
                        )}
                    />
                }
            />

            <Modal
                isOpen={isCreateProjectOpen}
                onClose={() => setCreateProjectOpen(false)}
                title={t('conversation.conversationHistory.newProjectTitle')}
                maxWidth="26rem"
            >
                <form
                    className={styles.projectForm}
                    onSubmit={e => {
                        e.preventDefault()
                        handleCreateProject()
                    }}
                >
                    <InputTextWithHint
                        placeholder={t('conversation.conversationHistory.projectNamePlaceholder')}
                        value={newProjectName}
                        onChange={e => setNewProjectName(e.target.value)}
                        autoFocus
                        data-testid="new-project-name-input"
                    />
                    <button
                        type="submit"
                        className={styles.projectPrimaryBtn}
                        disabled={!newProjectName.trim() || isCreatingProject}
                        data-testid="new-project-create-btn"
                    >
                        {isCreatingProject
                            ? t('conversation.conversationHistory.creatingProject')
                            : t('conversation.conversationHistory.createProject')}
                    </button>
                </form>
            </Modal>

            <Modal
                isOpen={moveTarget != null}
                onClose={() => setMoveTarget(null)}
                title={t('conversation.conversationHistory.moveToProjectTitle')}
                maxWidth="26rem"
            >
                {moveTarget != null && (
                    <div className={styles.projectPicker}>
                        {projects.length === 0 ? (
                            <p className={styles.pickerHint}>
                                {t('conversation.conversationHistory.noProjectsYet')}
                            </p>
                        ) : (
                            <ul className={styles.projectOptions}>
                                {projects.map(project => (
                                    <li key={project.projectId}>
                                        <button
                                            className={styles.projectOption}
                                            onClick={() => handleMoveToProject(moveTarget, project)}
                                            disabled={project.projectId === moveTarget.projectId}
                                            data-testid={`move-to-project-${project.projectId}`}
                                        >
                                            <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />
                                            <span className={styles.projectOptionName}>{project.name}</span>
                                            {project.projectId === moveTarget.projectId && (
                                                <span className={styles.projectOptionCurrent}>
                                                    {t('conversation.conversationHistory.currentProject')}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {moveTarget.projectId && (
                            <button
                                className={styles.projectSecondaryBtn}
                                onClick={() => handleRemoveFromProject(moveTarget)}
                                data-testid="remove-from-project-btn"
                            >
                                {t('conversation.conversationHistory.removeFromProject')}
                            </button>
                        )}
                    </div>
                )}
            </Modal>
        </>
    )
}
