import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { getCustomerConversations, archiveConversation } from '../../../services/conversationHistoryService'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import { CollapsedOpenAIBrandName, CollapsedClaudeBrandName, CollapsedGeminiBrandName } from '../../common/BrandName/BrandName'
import { AIVendor } from '../../../constants/vendors'
import styles from './ConversationHistory.module.scss'
import { loadHistoryCache, saveHistoryCache } from './historyCache'
import { parseServerDate, formatServerDateTime, formatServerTime } from '../../../utils/timeUtils'

const PAGE_SIZE = 15

type GroupId = 'today' | 'yesterday' | 'last7Days' | 'older'

interface GroupedConversations {
    id: GroupId;
    items: ConversationSummary[];
}

const groupConversations = (conversations: ConversationSummary[]): GroupedConversations[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const last7Days = new Date(today);
    last7Days.setDate(last7Days.getDate() - 7);

    const groups: GroupedConversations[] = [
        { id: 'today', items: [] as ConversationSummary[] },
        { id: 'yesterday', items: [] as ConversationSummary[] },
        { id: 'last7Days', items: [] as ConversationSummary[] },
        { id: 'older', items: [] as ConversationSummary[] }
    ];

    conversations.forEach(conv => {
        const d = parseServerDate(conv.updatedAt || conv.createdAt) ?? new Date();
        if (d >= today) {
            groups[0].items.push(conv);
        } else if (d >= yesterday) {
            groups[1].items.push(conv);
        } else if (d >= last7Days) {
            groups[2].items.push(conv);
        } else {
            groups[3].items.push(conv);
        }
    });

    return groups.filter(g => g.items.length > 0);
};

function ArchiveIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M2 4a1 1 0 011-1h10a1 1 0 011 1v1H2V4z"
                fill="currentColor"
            />
            <path
                d="M3 6h10v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm3.5 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z"
                fill="currentColor"
            />
        </svg>
    )
}

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

    const groupedItems = useMemo(() => groupConversations(items), [items])

    const groupLabels: Record<GroupId, string> = {
        today: t('conversation.conversationHistory.groups.today'),
        yesterday: t('conversation.conversationHistory.groups.yesterday'),
        last7Days: t('conversation.conversationHistory.groups.last7Days'),
        older: t('conversation.conversationHistory.groups.older'),
    }

    const [isScrolling, setIsScrolling] = useState(false)
    const scrollTimeout = React.useRef<NodeJS.Timeout | null>(null)

    const handleScroll = useCallback(() => {
        setIsScrolling(true)
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current)
        scrollTimeout.current = setTimeout(() => {
            setIsScrolling(false)
        }, 800)
    }, [])

    useEffect(() => {
        return () => {
            if (scrollTimeout.current) clearTimeout(scrollTimeout.current)
        }
    }, [])

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                {t('conversation.conversationHistory.title')}
            </div>

            {isLoading && items.length === 0 ? (
                <div className={styles.skeleton}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div
                            key={i}
                            className={styles.skeletonItem}
                            style={{ width: `${70 + (i % 3) * 10}%` }}
                        />
                    ))}
                </div>
            ) : error && items.length === 0 ? (
                // A failed background refresh keeps showing the stale list;
                // the error state is only for having nothing at all to show
                <div className={styles.emptyState}>{t('conversation.conversationHistory.failedToLoad')}</div>
            ) : items.length === 0 ? (
                <div className={styles.emptyState}>{t('conversation.conversationHistory.noConversationsYet')}</div>
            ) : (
                <div 
                    className={`${styles.list} ${isScrolling ? styles.scrolling : ''}`} 
                    aria-label={t('conversation.conversationHistory.listAriaLabel')}
                    onScroll={handleScroll}
                >
                    {groupedItems.map(group => (
                        <div key={group.id} className={styles.group}>
                            <div className={styles.groupHeader}>{groupLabels[group.id]}</div>
                            <ul className={styles.groupList}>
                                {group.items.map(conv => {
                                    const label = conv.title?.trim() || conv.conversationId
                                    const isActive = conv.conversationId === activeId
                                    return (
                                        <li key={conv.conversationId} className={styles.itemRow}>
                                            <button
                                                className={`${styles.item} ${isActive ? styles.active : ''}`}
                                                onClick={() => handleNavigate(conv.conversationId)}
                                                title={label}
                                                aria-current={isActive ? 'page' : undefined}
                                                data-testid={`conv-history-item-${conv.conversationId}`}
                                            >
                                                <div className={styles.itemContent}>
                                                    <div className={styles.itemHeader}>
                                                        <span className={styles.itemLabel}>{label}</span>
                                                    </div>
                                                    <div className={styles.itemDetails}>
                                                        <div className={styles.vendorIcons}>
                                                            {[...(conv.vendors || [])].sort().map((v, idx) => {
                                                                if (v === AIVendor.OPENAI) return <CollapsedOpenAIBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                if (v === AIVendor.CLAUDE) return <CollapsedClaudeBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                if (v === AIVendor.GEMINI) return <CollapsedGeminiBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                return null
                                                            })}
                                                        </div>
                                                        {(conv.vendors?.length ?? 0) > 0 && conv.updatedAt && (
                                                            <span className={styles.detailsSeparator} aria-hidden="true">·</span>
                                                        )}
                                                        {conv.updatedAt && (
                                                            <span className={styles.timestamp}>
                                                                {group.id === 'today' || group.id === 'yesterday'
                                                                    // The group header already names the day — time only
                                                                    ? formatServerTime(conv.updatedAt)
                                                                    : formatServerDateTime(conv.updatedAt)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>
                                            <button
                                                className={styles.archiveBtn}
                                                onClick={(e) => handleArchive(e, conv.conversationId)}
                                                title={t('conversation.conversationHistory.archiveConversation')}
                                                aria-label={t('conversation.conversationHistory.archiveConversation')}
                                                data-testid={`conv-archive-btn-${conv.conversationId}`}
                                            >
                                                <ArchiveIcon className={styles.archiveIcon} />
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            )}

            {hasMore && (
                <button
                    className={styles.loadMore}
                    onClick={handleLoadMore}
                    disabled={isLoading}
                    data-testid="conv-history-load-more"
                >
                    {isLoading ? t('conversation.conversationHistory.loading') : t('conversation.conversationHistory.loadMore')}
                </button>
            )}
        </div>
    )
}
