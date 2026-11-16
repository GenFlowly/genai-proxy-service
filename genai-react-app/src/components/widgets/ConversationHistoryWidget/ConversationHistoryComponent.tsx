import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { useToast } from '../../../context/ToastContext'
import {
    getCustomerConversations,
    getPinnedConversations,
    deleteConversation,
    pinConversation,
    unpinConversation,
    getProjects,
    getProjectConversations,
    createProject,
    assignConversationToProject,
    unassignConversationFromProject,
} from '../../../services/conversationHistoryService'
import { ConversationSummary, ForkConversationResponse, Project } from '../../../models/conversationHistory.models'
import { CollapsedVendorBrandName } from '../../common/BrandName/BrandName'
import { DeleteConfirmModal } from '../../common/DeleteConfirmModal/DeleteConfirmModal'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { CONVERSATION_FORKED_EVENT, CONVERSATION_LIST_CHANGED_EVENT } from '../../../constants/events'
import { SidebarListPanel, SidebarListGroup, SidebarListItem, Modal, InputTextWithHint, VerticalSplit } from '@genflowly/component-library'
import { sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import styles from './ConversationHistory.module.scss'
import { loadHistoryCache, saveHistoryCache, getExpandedProject, setExpandedProject, getExpandedSection, setExpandedSection } from './historyCache'
import { formatServerDateTime, formatServerTime, parseServerDate } from '../../../utils/timeUtils'

const PAGE_SIZE = 15
// Page size for a project's own member list (GET /projects/conversations)
const PROJECT_PAGE_SIZE = 50
// A failed older History page retries itself after these delays, then stops.
// There is no Load more button: older pages stream in as the end of the list
// nears.
const PAGE_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]

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

interface ConversationHistoryComponentProps {
    // Fired synchronously on tap/click, before the conversation has loaded —
    // lets a mobile full-screen overlay close itself immediately instead of
    // waiting on the (async, failure-prone) conversation load to flip some
    // unrelated piece of state
    onSelect?: () => void
    // The full-screen mobile menu: touch rows and a visible grip
    menu?: boolean
}

export default function ConversationHistoryComponent({ onSelect, menu = false }: ConversationHistoryComponentProps = {}) {
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
    // A project's member list comes from its OWN endpoint (projectIndex-backed),
    // fetched when the project expands — never derived from the recents/pinned
    // pages, which only ever hold a sliver of a project's membership
    const [projectItems, setProjectItems] = useState<Record<string, ConversationSummary[]>>(cached?.projectItems ?? {})
    // Projects already fetched this mount — the cached copy paints meanwhile
    const loadedProjectsRef = React.useRef<Set<string>>(new Set())

    // Project dialogs: the create form, and the conversation a
    // "Move to project" picker is currently open for
    const [isCreateProjectOpen, setCreateProjectOpen] = useState(false)
    const [newProjectName, setNewProjectName] = useState('')
    const [isCreatingProject, setIsCreatingProject] = useState(false)
    const [moveTarget, setMoveTarget] = useState<ConversationSummary | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)

    // The library's collapsible groups are uncontrolled (defaultExpanded is
    // read on mount), so force-expanding a project when a conversation is
    // started inside it works by bumping the group's id: the remounted group
    // re-reads the session expansion memory
    const [expandEpochs, setExpandEpochs] = useState<Record<string, number>>({})

    // Mirrors the Projects and Chats sections' own expanded state (the
    // library owns the real toggle; this is just our copy, kept in sync via
    // onToggle) so we can tell the split when every section is collapsed —
    // otherwise its panes keep reserving their full dragged/fill height and
    // a big dead block sits below the collapsed headers
    const [sectionExpanded, setSectionExpanded] = useState<Record<string, boolean>>(() => ({
        projects: getExpandedSection('projects') ?? true,
        history: getExpandedSection('history') ?? true,
    }))
    const toggleSection = (id: string, expanded: boolean) => {
        setExpandedSection(id, expanded)
        setSectionExpanded(prev => ({ ...prev, [id]: expanded }))
    }

    // Only persist state to the cache once a real load has happened, so an
    // empty "never loaded" state can't masquerade as "no conversations"
    const hasLoadedRef = React.useRef(!!cached)

    const [pageRetries, setPageRetries] = useState(0)

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
            setPageRetries(0)
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

    // Conversations assigned to a project THIS session, keyed by projectId.
    // A members fetch landing right after an assignment can predate the
    // projectIndex GSI catching up — these must survive a replacing fetch
    // until the server page confirms them (then the mark clears).
    const optimisticMembersRef = React.useRef<Map<string, ConversationSummary[]>>(new Map())

    // Fetches a project's members from [startKey] through its last page, so an
    // expanded project always shows all of them (there is no Load more row)
    const fetchProjectConversations = useCallback(async (projectId: string, startKey?: string | null) => {
        if (!isAuthenticated) return
        try {
            const token = await getAccessTokenSilently()
            let cursor = startKey
            do {
                const resp = await getProjectConversations(token, projectId, PROJECT_PAGE_SIZE, cursor)
                // Read the payload BEFORE setState: a malformed response must blow
                // up here inside the catch, not later inside React's updater
                const fetched = resp.conversations
                const nextCursor = resp.lastEvaluatedKey
                const appending = !!cursor
                hasLoadedRef.current = true
                const pending = optimisticMembersRef.current.get(projectId) ?? []
                const confirmed = new Set(fetched.map(c => c.conversationId))
                const stillPending = pending.filter(c => !confirmed.has(c.conversationId))
                if (stillPending.length !== pending.length) {
                    optimisticMembersRef.current.set(projectId, stillPending)
                }
                setProjectItems(prev => {
                    const existing = prev[projectId] ?? []
                    const merged = appending
                        ? [...existing, ...fetched.filter(c => !existing.some(e => e.conversationId === c.conversationId))]
                        : [...stillPending, ...fetched]
                    return { ...prev, [projectId]: merged }
                })
                if (nextCursor === cursor) break
                cursor = nextCursor
            } while (cursor)
        } catch {
            // Keep the cached members; a failed project refresh must not take
            // down the sidebar
        }
    }, [isAuthenticated, getAccessTokenSilently])

    // Fetch a project's members at most once per mount; expanding it again
    // reuses the loaded list (mutations keep it patched locally)
    const ensureProjectLoaded = useCallback((projectId: string) => {
        if (loadedProjectsRef.current.has(projectId)) return
        loadedProjectsRef.current.add(projectId)
        fetchProjectConversations(projectId, null)
    }, [fetchProjectConversations])

    // Local write-throughs for the per-project member lists, so mutations made
    // in the sidebar show up under the right project without a refetch.
    // Unloaded projects simply get the change when their fetch runs.

    const removeFromProjectItems = useCallback((convId: string) => {
        optimisticMembersRef.current.forEach((list, pid) => {
            optimisticMembersRef.current.set(pid, list.filter(c => c.conversationId !== convId))
        })
        setProjectItems(prev => {
            let changed = false
            const next: Record<string, ConversationSummary[]> = {}
            for (const [pid, list] of Object.entries(prev)) {
                const filtered = list.filter(c => c.conversationId !== convId)
                if (filtered.length !== list.length) changed = true
                next[pid] = filtered
            }
            return changed ? next : prev
        })
    }, [])

    const upsertIntoProjectItems = useCallback((projectId: string, conv: ConversationSummary) => {
        optimisticMembersRef.current.forEach((list, pid) => {
            optimisticMembersRef.current.set(pid, list.filter(c => c.conversationId !== conv.conversationId))
        })
        optimisticMembersRef.current.set(projectId, [
            conv,
            ...(optimisticMembersRef.current.get(projectId) ?? []),
        ])
        setProjectItems(prev => {
            const without = Object.fromEntries(
                Object.entries(prev).map(([pid, list]) => [
                    pid,
                    list.filter(c => c.conversationId !== conv.conversationId),
                ])
            )
            return { ...without, [projectId]: [conv, ...(without[projectId] ?? [])] }
        })
    }, [])

    const patchProjectItemsEntry = useCallback((convId: string, patch: (c: ConversationSummary) => ConversationSummary) =>
        setProjectItems(prev => {
            let changed = false
            const next = Object.fromEntries(
                Object.entries(prev).map(([pid, list]) => [
                    pid,
                    list.map(c => {
                        if (c.conversationId !== convId) return c
                        changed = true
                        return patch(c)
                    }),
                ])
            )
            return changed ? next : prev
        }), [])

    // Load first page on mount / auth change (background refresh when cached)
    useEffect(() => {
        fetchPage(null)
        fetchPinned()
        fetchProjects()
    }, [fetchPage, fetchPinned, fetchProjects])

    // The active conversation's project, resolved from whatever list already
    // carries it (recents page, pinned) — members may not be fetched yet, and
    // that project must still auto-expand and load on a deep link
    const activeProjectId = useMemo(() => {
        if (!activeId) return null
        const match = [...pinned, ...items].find(c => c.conversationId === activeId)
        return match?.projectId ?? null
    }, [activeId, pinned, items])

    // Projects that render expanded (session toggle memory, or they hold the
    // active conversation) need their members without waiting for a manual
    // re-toggle; everything else stays lazy — zero per-project requests at
    // login
    useEffect(() => {
        for (const project of projects) {
            const members = projectItems[project.projectId] ?? []
            const containsActive = !!activeId && (
                project.projectId === activeProjectId ||
                members.some(c => c.conversationId === activeId)
            )
            if (getExpandedProject(project.projectId) ?? containsActive) {
                ensureProjectLoaded(project.projectId)
                // The active conversation's project must open on its own (deep
                // link / refresh), but the group reads defaultExpanded only on
                // mount — record the expansion and remount it via the epoch.
                // Only when the user never toggled it: their collapse wins.
                if (containsActive && getExpandedProject(project.projectId) === undefined) {
                    setExpandedProject(project.projectId, true)
                    setExpandEpochs(prev => ({
                        ...prev,
                        [project.projectId]: (prev[project.projectId] ?? 0) + 1,
                    }))
                }
            }
        }
    }, [projects, projectItems, activeId, activeProjectId, ensureProjectLoaded])

    // Mirror every loaded/mutated state (fetch, delete, pin, title patch) to
    // the cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveHistoryCache(customerId, { items, pinned, lastKey, hasMore, projects, projectItems })
    }, [customerId, items, pinned, lastKey, hasMore, projects, projectItems])

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
        // Project member lists carry their own copy of the summary
        patchProjectItemsEntry(conversationId, c =>
            c.title === conversationTitle ? c : { ...c, title: conversationTitle }
        )
        // A conversation born inside a project (message+ on the project row)
        // joins its project's member list the moment it gets a title
        if (pendingProjectId) {
            setProjectItems(prev => {
                const list = prev[pendingProjectId] ?? []
                if (list.some(c => c.conversationId === conversationId)) return prev
                return {
                    ...prev,
                    [pendingProjectId]: [{
                        conversationId,
                        title: conversationTitle,
                        createdAt: null,
                        updatedAt: null,
                        projectId: pendingProjectId,
                    }, ...list],
                }
            })
        }
    }, [conversationId, conversationTitle, pendingProjectId, projects, patchProjectItemsEntry])

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
            if (summary.projectId) {
                upsertIntoProjectItems(summary.projectId, summary)
            }
        }
        window.addEventListener(CONVERSATION_FORKED_EVENT, onForked)
        return () => window.removeEventListener(CONVERSATION_FORKED_EVENT, onForked)
    }, [projects, upsertIntoProjectItems])

    useEffect(() => {
        const onChanged = () => { fetchPage() }
        window.addEventListener(CONVERSATION_LIST_CHANGED_EVENT, onChanged)
        return () => window.removeEventListener(CONVERSATION_LIST_CHANGED_EVENT, onChanged)
    }, [fetchPage])

    const handleLoadMore = () => fetchPage(lastKey)

    useEffect(() => {
        if (!error || !hasMore || !lastKey || pageRetries >= PAGE_RETRY_DELAYS_MS.length) return
        const timer = setTimeout(() => {
            setPageRetries(n => n + 1)
            void fetchPage(lastKey)
        }, PAGE_RETRY_DELAYS_MS[pageRetries])
        return () => clearTimeout(timer)
    }, [error, hasMore, lastKey, pageRetries, fetchPage])

    const handleNavigate = (convId: string) => {
        navigate(`/chat/${convId}`)
        onSelect?.()
    }

    // Deleting is permanent, so it always asks first
    const handleDelete = async () => {
        if (!deleteTarget) return
        const convId = deleteTarget.conversationId
        setIsDeleting(true)
        setDeleteError(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteConversation(token, convId)
            setItems(prev => prev.filter(c => c.conversationId !== convId))
            setPinned(prev => prev.filter(c => c.conversationId !== convId))
            removeFromProjectItems(convId)
            setDeleteTarget(null)
            if (convId === activeId) {
                navigate('/chat')
            }
        } catch (err) {
            console.error('Failed to delete conversation:', err)
            setDeleteError(t('conversation.conversationHistory.deleteFailed'))
        } finally {
            setIsDeleting(false)
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
        // A project member moves to its project's Pinned subsection
        patchProjectItemsEntry(conv.conversationId, c => ({ ...c, pinnedAt: new Date().toISOString() }))
        try {
            const token = await getAccessTokenSilently()
            await pinConversation(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.pinnedToast'))
        } catch (err) {
            console.error('Failed to pin conversation:', err)
            setPinned(prev => prev.filter(c => c.conversationId !== conv.conversationId))
            patchProjectItemsEntry(conv.conversationId, c => ({ ...c, pinnedAt: undefined }))
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
        patchProjectItemsEntry(conv.conversationId, c => ({ ...c, pinnedAt: undefined }))
        try {
            const token = await getAccessTokenSilently()
            await unpinConversation(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.unpinnedToast'))
        } catch (err) {
            console.error('Failed to unpin conversation:', err)
            setPinned(previousPinned)
            patchProjectItemsEntry(conv.conversationId, c => ({ ...c, pinnedAt: conv.pinnedAt }))
            showToast(t('conversation.conversationHistory.unpinFailed'))
        }
    }

    // ─── Projects ────────────────────────────────────────────────────────────

    const applyProjectLocally = (conv: ConversationSummary, projectId: string | null, projectName: string | null) => {
        const patch = (c: ConversationSummary) =>
            c.conversationId === conv.conversationId ? { ...c, projectId, projectName } : c
        setItems(prev => prev.map(patch))
        setPinned(prev => prev.map(patch))
        if (projectId) upsertIntoProjectItems(projectId, { ...conv, projectId, projectName })
        else removeFromProjectItems(conv.conversationId)
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
        applyProjectLocally(conv, project.projectId, project.name)
        setExpandedProject(project.projectId, true)
        try {
            const token = await getAccessTokenSilently()
            await assignConversationToProject(token, conv.conversationId, project.projectId)
            // No immediate members refetch: the projectIndex GSI may not have
            // caught up yet and would clobber the optimistic entry. The real
            // membership loads on the next expand.
            showToast(t('conversation.conversationHistory.movedToProject', { name: project.name }))
        } catch (err) {
            console.error('Failed to move conversation to project:', err)
            applyProjectLocally(conv, previous.projectId, previous.projectName)
            showToast(t('conversation.conversationHistory.moveToProjectFailed'))
        }
    }

    const handleRemoveFromProject = async (conv: ConversationSummary) => {
        setMoveTarget(null)
        const previous = { projectId: conv.projectId ?? null, projectName: conv.projectName ?? null }
        applyProjectLocally(conv, null, null)
        try {
            const token = await getAccessTokenSilently()
            await unassignConversationFromProject(token, conv.conversationId)
            showToast(t('conversation.conversationHistory.removedFromProject'))
        } catch (err) {
            console.error('Failed to remove conversation from project:', err)
            applyProjectLocally(conv, previous.projectId, previous.projectName)
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

    // A project's members come from its own projectIndex-backed fetch
    // (projectItems), NOT from bucketing the loaded recents/pinned pages —
    // those pages only ever hold a sliver of a project's membership, which is
    // why projects used to render empty after a reload. Assigned
    // conversations are excluded from the global sections; one with a
    // dangling projectId (its project just deleted elsewhere) falls through
    // to the global sections rather than disappearing.
    const { projectBuckets, globalPinned, globalRecent } = useMemo(() => {
        const projectBuckets: ProjectBucket[] = projects.map(project => {
            const members = projectItems[project.projectId] ?? []
            return {
                id: project.projectId,
                name: project.name,
                pinned: members.filter(c => c.pinnedAt),
                recent: members.filter(c => !c.pinnedAt),
            }
        })
        const projectIds = new Set(projects.map(p => p.projectId))
        const inProject = (c: ConversationSummary) => !!c.projectId && projectIds.has(c.projectId)
        return {
            projectBuckets,
            globalPinned: pinned.filter(c => !inProject(c)),
            globalRecent: recentItems.filter(c => !inProject(c)),
        }
    }, [pinned, recentItems, projects, projectItems])

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
            label: conv.title?.trim() || (menu ? t('conversation.conversationHistory.untitledConversation') : conv.conversationId),
            details: renderDetails(conv),
            isActive: conv.conversationId === activeId,
            ariaCurrent: 'page' as const,
            onSelect: () => handleNavigate(conv.conversationId),
            testId: `conv-history-item-${conv.conversationId}`,
            actions: [
                {
                    icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.moveToProject'),
                    tone: 'neutral' as const,
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
                    tone: 'primary' as const,
                    onClick: (e: React.MouseEvent) => (isPinned ? handleUnpin(e, conv) : handlePin(e, conv)),
                    revealOnHover: true,
                    testId: `conv-${isPinned ? 'unpin' : 'pin'}-btn-${conv.conversationId}`,
                },
                {
                    icon: <Icon src={ICONS.TRASH} size={14} aria-hidden={true} />,
                    label: t('conversation.conversationHistory.deleteConversation'),
                    tone: 'muted' as const,
                    onClick: (e: React.MouseEvent) => {
                        e.stopPropagation()
                        setDeleteError(null)
                        setDeleteTarget(conv)
                    },
                    testId: `conv-delete-btn-${conv.conversationId}`,
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
        ensureProjectLoaded(project.id)
        setExpandEpochs(prev => ({ ...prev, [project.id]: (prev[project.id] ?? 0) + 1 }))
        startConversationInProject?.(project.id)
    }

    const toProjectGroup = (project: ProjectBucket): SidebarListGroup => {
        const containsActive =
            !!activeId &&
            [...project.pinned, ...project.recent].some(c => c.conversationId === activeId)
        const expandEpoch = expandEpochs[project.id]
        // A project whose members were never fetched (or cached) must still be
        // expandable — the library only renders expand semantics when there is
        // something inside, and expanding is exactly what triggers the lazy
        // fetch. A placeholder row fills the gap until the first page lands;
        // a fetched-and-empty project legitimately renders chevron-less.
        const membersKnown = projectItems[project.id] !== undefined
        const loadingRow: SidebarListItem[] = !membersKnown
            ? [{
                id: `project-${project.id}-loading`,
                label: t('conversation.conversationHistory.loading'),
                onSelect: () => ensureProjectLoaded(project.id),
                testId: `conv-history-project-loading-${project.id}`,
            }]
            : []
        return {
            id: expandEpoch ? `project-${project.id}-x${expandEpoch}` : `project-${project.id}`,
            label: project.name,
            collapsible: true,
            defaultExpanded: getExpandedProject(project.id) ?? containsActive,
            icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
            onToggle: expanded => {
                setExpandedProject(project.id, expanded)
                // Lazy load: a project's members are first fetched the moment
                // the user opens it, so the login burst stays project-free
                if (expanded) ensureProjectLoaded(project.id)
            },
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
                ...(project.recent.length > 0 || loadingRow.length > 0
                    ? [{
                        id: `project-${project.id}-recent`,
                        label: t('conversation.conversationHistory.recent'),
                        items: [...toTreeRows(project.recent, false), ...loadingRow],
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
            collapsible: true,
            defaultExpanded: sectionExpanded.projects,
            onToggle: expanded => toggleSection('projects', expanded),
            testId: 'conv-history-projects-heading',
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

    // The Chats card below it: one collapsible section whose Pinned and
    // Recents scroll together. Projects and Chats are two separate cards,
    // each with its own collapsed state, so either one hugs its header once
    // nothing in it is expanded (VerticalSplit's topCollapsed/bottomCollapsed)
    const topCollapsed = projectBuckets.length === 0 || !sectionExpanded.projects
    const pinnedPresent = globalPinned.length > 0
    const recentPresent = globalRecent.length > 0
    const bottomCollapsed = (pinnedPresent || recentPresent) && !sectionExpanded.history

    const chatsGroups: SidebarListGroup[] = pinnedPresent || recentPresent
        ? [{
            id: 'history',
            label: t('conversation.conversationHistory.chats'),
            collapsible: true,
            defaultExpanded: sectionExpanded.history,
            onToggle: expanded => toggleSection('history', expanded),
            testId: 'conv-history-history-heading',
            groups: [
                ...(pinnedPresent
                    ? [{
                        id: 'pinned',
                        label: t('conversation.conversationHistory.pinned'),
                        icon: <Icon src={ICONS.PIN} size={13} aria-hidden={true} />,
                        items: toTreeRows(globalPinned, true),
                    }]
                    : []),
                ...(recentPresent
                    ? [{
                        id: 'recent',
                        label: t('conversation.conversationHistory.recents'),
                        items: toTreeRows(globalRecent, false),
                    }]
                    : []),
            ],
        }]
        : []
    const recentsVisible = sectionExpanded.history

    return (
        <>
            <VerticalSplit
                storageKey={HISTORY_SPLIT_STORAGE_KEY}
                separatorLabel={t('conversation.conversationHistory.resizePanels')}
                topCollapsed={topCollapsed}
                bottomCollapsed={bottomCollapsed}
                showGrip={menu}
                handleTestId="history-split-handle"
                topTestId="projects-pane"
                bottomTestId="history-pane"
                top={showProjectsPanel ? (
                    <SidebarListPanel
                        variant={menu ? 'menu' : 'default'}
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
                        variant={menu ? 'menu' : 'default'}
                        groups={chatsGroups}
                        testIds={{ list: 'history-scroll-list', endSentinel: 'history-end-sentinel' }}
                        // Older pages stream in as the end of the list nears;
                        // paused while a fetch runs and after a failure —
                        // re-arming on a failing request would loop, so a
                        // failed page retries itself with backoff instead
                        // (PAGE_RETRY_DELAYS_MS).
                        // Collapsed Recents has no visible end to reach —
                        // without this gate, the panel's own end-sentinel
                        // sits in view of a now-tiny scroll area and the
                        // IntersectionObserver re-fires on every resulting
                        // re-render, looping fetches behind a closed section
                        onEndReached={hasMore && !isLoading && !error && recentsVisible ? handleLoadMore : undefined}
                        isLoading={isLoading}
                        hasError={error}
                        errorText={t('conversation.conversationHistory.failedToLoad')}
                        emptyText={t('conversation.conversationHistory.noConversationsYet')}
                        listAriaLabel={t('conversation.conversationHistory.listAriaLabel')}
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

            <DeleteConfirmModal
                isOpen={deleteTarget != null}
                title={t('conversation.conversationHistory.deleteConversationTitle')}
                message={t('conversation.conversationHistory.deleteConversationConfirm')}
                isDeleting={isDeleting}
                error={deleteError}
                onConfirm={handleDelete}
                onCancel={() => setDeleteTarget(null)}
                data-testid="delete-conversation"
            />
        </>
    )
}
