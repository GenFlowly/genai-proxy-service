import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { getCustomerConversations, archiveConversation } from '../../../services/conversationHistoryService'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import { CollapsedOpenAIBrandName, CollapsedClaudeBrandName, CollapsedGeminiBrandName } from '@genflowly/component-library'
import { AIVendor } from '../../../constants/vendors'
import { ArchiveIcon } from '@genflowly/component-library'
import { SidebarListPanel, SidebarListGroup, SidebarListLoadMore } from '@genflowly/component-library'
import { sidebarListPanelStyles as panelStyles } from '@genflowly/component-library'
import styles from './ConversationHistory.module.scss'
import { loadHistoryCache, saveHistoryCache } from './historyCache'
import { formatServerDateTime, formatServerTime } from '../../../utils/timeUtils'
import { groupByDate, DateGroupId } from '../../../utils/dateGrouping'

const PAGE_SIZE = 15

export default function ConversationHistoryComponent() {
    const { t } = useTranslation()
    const { getAccessTokenSilently, isAuthenticated } = useAuth()
    const { conversationId, conversationTitle } = useConversation()
    const navigate = useNavigate()
    const { conversationId: activeId } = useParams<{ conversationId: string }>()

    // Stale-while-revalidate: paint the last known list immediately (if any),
    // then refresh from the API in the background
    const cached = useMemo(loadHistoryCache, [])
    const [items, setItems] = useState<ConversationSummary[]>(cached?.items ?? [])
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

    // Load first page on mount / auth change (background refresh when cached)
    useEffect(() => {
        fetchPage(null)
    }, [fetchPage])

    // Mirror every loaded/mutated state (fetch, archive, title patch) to the
    // cache so the next mount paints instantly
    useEffect(() => {
        if (!hasLoadedRef.current) return
        saveHistoryCache({ items, lastKey, hasMore })
    }, [items, lastKey, hasMore])

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
            // If the archived conversation is currently active, navigate away
            if (convId === activeId) {
                navigate('/chat')
            }
        } catch (err) {
            console.error('Failed to archive conversation:', err)
        }
    }

    const groupedItems = useMemo(
        () => groupByDate(items, conv => conv.updatedAt || conv.createdAt),
        [items]
    )

    const groupLabels: Record<DateGroupId, string> = {
        today: t('common.dateGroups.today'),
        yesterday: t('common.dateGroups.yesterday'),
        last7Days: t('common.dateGroups.last7Days'),
        older: t('common.dateGroups.older'),
    }

    const renderDetails = (conv: ConversationSummary, groupId: DateGroupId) => (
        <>
            <div className={styles.vendorIcons}>
                {[...(conv.vendors || [])].sort().map((v, idx) => {
                    if (v === AIVendor.OPENAI) return <CollapsedOpenAIBrandName key={idx} size={11} className={styles.vendorIcon} />
                    if (v === AIVendor.CLAUDE) return <CollapsedClaudeBrandName key={idx} size={11} className={styles.vendorIcon} />
                    if (v === AIVendor.GEMINI) return <CollapsedGeminiBrandName key={idx} size={11} className={styles.vendorIcon} />
                    return null
                })}
            </div>
            {(conv.vendors?.length ?? 0) > 0 && conv.updatedAt && (
                <span className={panelStyles.detailsSeparator} aria-hidden="true">·</span>
            )}
            {conv.updatedAt && (
                <span className={panelStyles.timestamp}>
                    {groupId === 'today' || groupId === 'yesterday'
                        // The group header already names the day — time only
                        ? formatServerTime(conv.updatedAt)
                        : formatServerDateTime(conv.updatedAt)}
                </span>
            )}
        </>
    )

    const groups: SidebarListGroup[] = groupedItems.map(group => ({
        id: group.id,
        label: groupLabels[group.id],
        items: group.items.map(conv => {
            const label = conv.title?.trim() || conv.conversationId
            return {
                id: conv.conversationId,
                label,
                details: renderDetails(conv, group.id),
                isActive: conv.conversationId === activeId,
                ariaCurrent: 'page' as const,
                onSelect: () => handleNavigate(conv.conversationId),
                testId: `conv-history-item-${conv.conversationId}`,
                action: {
                    icon: <ArchiveIcon />,
                    label: t('conversation.conversationHistory.archiveConversation'),
                    onClick: (e: React.MouseEvent) => handleArchive(e, conv.conversationId),
                    testId: `conv-archive-btn-${conv.conversationId}`,
                },
            }
        }),
    }))

    return (
        <SidebarListPanel
            title={t('conversation.conversationHistory.title')}
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
