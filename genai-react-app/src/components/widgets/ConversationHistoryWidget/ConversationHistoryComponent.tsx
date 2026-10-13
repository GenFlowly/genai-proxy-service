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
} from '../../../services/conversationHistoryService'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import { CollapsedVendorBrandName } from '../../common/BrandName/BrandName'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import { SidebarListPanel, SidebarListGroup, SidebarListLoadMore } from '@genflowly/component-library'
import { sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import styles from './ConversationHistory.module.scss'
import { loadHistoryCache, saveHistoryCache, getExpandedProject, setExpandedProject } from './historyCache'
import { formatServerDateTime, formatServerTime, parseServerDate } from '../../../utils/timeUtils'

const PAGE_SIZE = 15

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
    const { conversationId, conversationTitle } = useConversation()
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

    // Load first page on mount / auth change (background refresh when cached)
    useEffect(() => {
        fetchPage(null)
        fetchPinned()
    }, [fetchPage, fetchPinned])

    // Mirror every loaded/mutated state (fetch, archive, pin, title patch) to
    // the cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveHistoryCache(customerId, { items, pinned, lastKey, hasMore })
    }, [customerId, items, pinned, lastKey, hasMore])

    // Patch title in list when the active conversation gets a generated title
    useEffect(() => {
        if (!conversationId || !conversationTitle) return
        setItems(prev => {
            const idx = prev.findIndex(c => c.conversationId === conversationId)
            if (idx === -1) {
                // Conversation not yet in list (e.g. brand new) — prepend it
                return [{ conversationId, title: conversationTitle, createdAt: null, updatedAt: null }, ...prev]
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
    }, [conversationId, conversationTitle])

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
    const { projects, globalPinned, globalRecent } = useMemo(() => {
        const buckets = new Map<string, ProjectBucket>()
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
        return { projects: Array.from(buckets.values()), globalPinned, globalRecent }
    }, [pinned, recentItems])

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

    // A project renders as a collapsible row holding its own Pinned/Recent
    // subsections. First mount expands the project of the active conversation;
    // after that the user's own toggles win for the rest of the session
    const toProjectGroup = (project: ProjectBucket): SidebarListGroup => {
        const containsActive =
            !!activeId &&
            [...project.pinned, ...project.recent].some(c => c.conversationId === activeId)
        return {
            id: `project-${project.id}`,
            label: project.name,
            collapsible: true,
            defaultExpanded: getExpandedProject(project.id) ?? containsActive,
            icon: <Icon src={ICONS.FOLDER} size={14} aria-hidden={true} />,
            onToggle: expanded => setExpandedProject(project.id, expanded),
            testId: `conv-history-project-${project.id}`,
            groups: [
                ...(project.pinned.length > 0
                    ? [{
                        id: `project-${project.id}-pinned`,
                        label: t('conversation.conversationHistory.pinned'),
                        items: project.pinned.map(conv => toRow(conv, true)),
                    }]
                    : []),
                ...(project.recent.length > 0
                    ? [{
                        id: `project-${project.id}-recent`,
                        label: t('conversation.conversationHistory.recent'),
                        items: project.recent.map(conv => toRow(conv, false)),
                    }]
                    : []),
            ],
        }
    }

    // Projects on top, then the global Pinned and Recents sections; sections
    // with nothing to show are omitted
    const groups: SidebarListGroup[] = [
        ...(projects.length > 0
            ? [{
                id: 'projects',
                label: t('conversation.conversationHistory.projects'),
                groups: projects.map(toProjectGroup),
            }]
            : []),
        ...(globalPinned.length > 0
            ? [{
                id: 'pinned',
                label: t('conversation.conversationHistory.pinned'),
                items: globalPinned.map(conv => toRow(conv, true)),
            }]
            : []),
        ...(globalRecent.length > 0
            ? [{
                id: 'recent',
                label: t('conversation.conversationHistory.recents'),
                items: globalRecent.map(conv => toRow(conv, false)),
            }]
            : []),
    ]

    return (
        <SidebarListPanel
            groups={groups}
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
    )
}
