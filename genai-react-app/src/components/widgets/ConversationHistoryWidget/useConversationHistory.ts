import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    renameProject,
    deleteProject,
    assignConversationToProject,
    unassignConversationFromProject,
} from '../../../services/conversationHistoryService'
import { ConversationSummary, ForkConversationResponse, Project } from '../../../models/conversationHistory.models'
import { CONVERSATION_FORKED_EVENT, CONVERSATION_LIST_CHANGED_EVENT } from '../../../constants/events'
import {
    loadHistoryCache,
    saveHistoryCache,
    getExpandedProject,
    setExpandedProject,
    getExpandedSection,
    setExpandedSection,
} from './historyCache'

const PAGE_SIZE = 15
// Page size for a project's own member list (GET /projects/conversations)
const PROJECT_PAGE_SIZE = 50
// A failed older History page retries itself after these delays, then stops.
// There is no Load more button: older pages stream in as the end of the list
// nears.
const PAGE_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]

/** A project with its own pinned and recent conversations. */
export interface ProjectBucket {
    id: string
    name: string
    pinned: ConversationSummary[]
    recent: ConversationSummary[]
}

/**
 * Everything the Projects and Chats widgets show and do: the lists (recents
 * paged, pinned, projects with their members fetched lazily), their mutations
 * and the state of the dialogs those mutations open. One instance feeds both
 * widgets, so a change in one shows in the other at once.
 */
export function useConversationHistory({ onSelect }: { onSelect?: () => void } = {}) {
    const { t } = useTranslation()
    const { getAccessTokenSilently, isAuthenticated, customerId } = useAuth()
    const {
        conversationId,
        conversationTitle,
        pendingProjectId,
        startConversationInProject,
        clearPendingProject,
    } = useConversation()
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
    const loadedProjectsRef = useRef<Set<string>>(new Set())

    const [isCreateProjectOpen, setCreateProjectOpen] = useState(false)
    const [newProjectName, setNewProjectName] = useState('')
    const [isCreatingProject, setIsCreatingProject] = useState(false)
    const [renameTarget, setRenameTarget] = useState<ProjectBucket | null>(null)
    const [renameName, setRenameName] = useState('')
    const [isRenamingProject, setIsRenamingProject] = useState(false)
    const [deleteProjectTarget, setDeleteProjectTarget] = useState<ProjectBucket | null>(null)
    const [isDeletingProject, setIsDeletingProject] = useState(false)
    const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null)
    const [moveTarget, setMoveTarget] = useState<ConversationSummary | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)

    // The library's collapsible groups are uncontrolled (defaultExpanded is
    // read on mount), so force-expanding a project when a conversation is
    // started inside it works by bumping the group's id: the remounted group
    // re-reads the session expansion memory
    const [expandEpochs, setExpandEpochs] = useState<Record<string, number>>({})

    // Whether the Projects and Chats widgets are expanded, remembered for the
    // session; the split hugs a collapsed widget's header
    const [sectionExpanded, setSectionExpanded] = useState<Record<string, boolean>>(() => ({
        projects: getExpandedSection('projects') ?? true,
        history: getExpandedSection('history') ?? true,
    }))
    const toggleSection = useCallback((id: 'projects' | 'history', expanded: boolean) => {
        setExpandedSection(id, expanded)
        setSectionExpanded(prev => ({ ...prev, [id]: expanded }))
    }, [])

    // Only persist state to the cache once a real load has happened, so an
    // empty "never loaded" state can't masquerade as "no conversations"
    const hasLoadedRef = useRef(!!cached)

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

    // The user's projects; they render in the Projects widget even while
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
    const optimisticMembersRef = useRef<Map<string, ConversationSummary[]>>(new Map())

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
                // One started inside a project (the plus on the project row)
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
        // A conversation born inside a project joins its project's member list
        // the moment it gets a title
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

    const loadMore = useCallback(() => { fetchPage(lastKey) }, [fetchPage, lastKey])

    useEffect(() => {
        if (!error || !hasMore || !lastKey || pageRetries >= PAGE_RETRY_DELAYS_MS.length) return
        const timer = setTimeout(() => {
            setPageRetries(n => n + 1)
            void fetchPage(lastKey)
        }, PAGE_RETRY_DELAYS_MS[pageRetries])
        return () => clearTimeout(timer)
    }, [error, hasMore, lastKey, pageRetries, fetchPage])

    const navigateTo = (convId: string) => {
        navigate(`/chat/${convId}`)
        onSelect?.()
    }

    // ─── Conversations ───────────────────────────────────────────────────────

    // Deleting is permanent, so it always asks first
    const requestDelete = (conv: ConversationSummary) => {
        setDeleteError(null)
        setDeleteTarget(conv)
    }

    const cancelDelete = () => setDeleteTarget(null)

    const confirmDelete = async () => {
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

    const pin = async (e: React.MouseEvent, conv: ConversationSummary) => {
        e.stopPropagation()
        // Optimistic: surface it in the Pinned section right away; the item
        // stays in `items` and is excluded from Recents while pinned
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

    const unpin = async (e: React.MouseEvent, conv: ConversationSummary) => {
        e.stopPropagation()
        const previousPinned = pinned
        setPinned(prev => prev.filter(c => c.conversationId !== conv.conversationId))
        // A pinned conversation older than the loaded pages may not be in
        // `items` yet — put it back so it lands in Recents in date order
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

    const openCreateProject = () => setCreateProjectOpen(true)
    const closeCreateProject = () => setCreateProjectOpen(false)

    const submitCreateProject = async () => {
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

    const openRenameProject = (project: ProjectBucket) => {
        setRenameName(project.name)
        setRenameTarget(project)
    }
    const closeRenameProject = () => setRenameTarget(null)

    const submitRenameProject = async () => {
        const target = renameTarget
        const name = renameName.trim()
        if (!target || !name || name === target.name || isRenamingProject) return
        setIsRenamingProject(true)
        try {
            const token = await getAccessTokenSilently()
            await renameProject(token, target.id, name)
            const rename = (c: ConversationSummary) => (c.projectId === target.id ? { ...c, projectName: name } : c)
            setProjects(prev => prev.map(p => (p.projectId === target.id ? { ...p, name } : p)))
            setItems(prev => prev.map(rename))
            setPinned(prev => prev.map(rename))
            setProjectItems(prev => Object.fromEntries(
                Object.entries(prev).map(([pid, list]) => [pid, list.map(rename)])
            ))
            setRenameTarget(null)
            showToast(t('conversation.conversationHistory.projectRenamed'))
        } catch (err) {
            console.error('Failed to rename project:', err)
            showToast(t('conversation.conversationHistory.renameProjectFailed'))
        } finally {
            setIsRenamingProject(false)
        }
    }

    const requestDeleteProject = (project: ProjectBucket) => {
        setDeleteProjectError(null)
        setDeleteProjectTarget(project)
    }
    const cancelDeleteProject = () => setDeleteProjectTarget(null)

    const confirmDeleteProject = async () => {
        const target = deleteProjectTarget
        if (!target) return
        setIsDeletingProject(true)
        setDeleteProjectError(null)
        try {
            const token = await getAccessTokenSilently()
            await deleteProject(token, target.id)
            // The server unassigns the project's conversations; they return to
            // Pinned and Recents where those lists hold them
            const unassign = (c: ConversationSummary) =>
                c.projectId === target.id ? { ...c, projectId: null, projectName: null } : c
            optimisticMembersRef.current.delete(target.id)
            loadedProjectsRef.current.delete(target.id)
            setProjects(prev => prev.filter(p => p.projectId !== target.id))
            setItems(prev => prev.map(unassign))
            setPinned(prev => prev.map(unassign))
            setProjectItems(prev => {
                const next = { ...prev }
                delete next[target.id]
                return next
            })
            if (pendingProjectId === target.id) clearPendingProject?.()
            setDeleteProjectTarget(null)
            showToast(t('conversation.conversationHistory.projectDeleted'))
        } catch (err) {
            console.error('Failed to delete project:', err)
            setDeleteProjectError(t('conversation.conversationHistory.deleteProjectFailed'))
        } finally {
            setIsDeletingProject(false)
        }
    }

    const moveToProject = async (conv: ConversationSummary, project: Project) => {
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

    const removeFromProject = async (conv: ConversationSummary) => {
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

    // Start a fresh conversation that will be born inside the project on its
    // first message; keep the project open so it is visible once it appears
    const newConversationInProject = (projectId: string) => {
        setExpandedProject(projectId, true)
        ensureProjectLoaded(projectId)
        setExpandEpochs(prev => ({ ...prev, [projectId]: (prev[projectId] ?? 0) + 1 }))
        startConversationInProject?.(projectId)
        onSelect?.()
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
    // those pages only ever hold a sliver of a project's membership.
    // Assigned conversations are excluded from the global sections; one with
    // a dangling projectId (its project just deleted elsewhere) falls through
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

    // The Projects widget shows whenever there is anything to show or the
    // first load has settled, so projects are discoverable and creatable
    // right from the sidebar; it only steps aside for the initial skeleton
    // and the nothing-at-all error state
    const hasAnyData = items.length > 0 || pinned.length > 0 || projects.length > 0
    const showProjectsPanel = hasAnyData || (!isLoading && !error)

    return {
        activeId,
        projects,
        projectItems,
        projectBuckets,
        globalPinned,
        globalRecent,
        isLoading,
        error,
        hasMore,
        showProjectsPanel,
        sectionExpanded,
        toggleSection,
        expandEpochs,
        ensureProjectLoaded,
        loadMore,
        navigateTo,
        pin,
        unpin,
        newConversationInProject,
        // Create project dialog
        isCreateProjectOpen,
        newProjectName,
        setNewProjectName,
        isCreatingProject,
        openCreateProject,
        closeCreateProject,
        submitCreateProject,
        // Rename project dialog
        renameTarget,
        renameName,
        setRenameName,
        isRenamingProject,
        openRenameProject,
        closeRenameProject,
        submitRenameProject,
        // Delete project dialog
        deleteProjectTarget,
        isDeletingProject,
        deleteProjectError,
        requestDeleteProject,
        cancelDeleteProject,
        confirmDeleteProject,
        // Move to project dialog
        moveTarget,
        setMoveTarget,
        moveToProject,
        removeFromProject,
        // Delete conversation dialog
        deleteTarget,
        isDeleting,
        deleteError,
        requestDelete,
        cancelDelete,
        confirmDelete,
    }
}

export type ConversationHistory = ReturnType<typeof useConversationHistory>
