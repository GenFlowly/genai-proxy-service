import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { getCustomerConversations, archiveConversation } from '../../../services/conversationHistoryService'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import { CollapsedOpenAIBrandName, CollapsedClaudeBrandName, CollapsedGeminiBrandName } from '../../common/BrandName/BrandName'
import { AIVendor } from '../../../constants/vendors'
import styles from './ConversationHistory.module.scss'

const PAGE_SIZE = 15

interface GroupedConversations {
    label: string;
    items: ConversationSummary[];
}

const groupConversations = (conversations: ConversationSummary[]): GroupedConversations[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const last7Days = new Date(today);
    last7Days.setDate(last7Days.getDate() - 7);

    const groups = [
        { label: 'Today', items: [] as ConversationSummary[] },
        { label: 'Yesterday', items: [] as ConversationSummary[] },
        { label: 'Last 7 days', items: [] as ConversationSummary[] },
        { label: 'Older', items: [] as ConversationSummary[] }
    ];

    conversations.forEach(conv => {
        const d = new Date(conv.updatedAt || conv.createdAt || Date.now());
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
    const { getAccessTokenSilently, isAuthenticated } = useAuth()
    const { conversationId, conversationTitle } = useConversation()
    const navigate = useNavigate()
    const { conversationId: activeId } = useParams<{ conversationId: string }>()

    const [items, setItems] = useState<ConversationSummary[]>([])
    const [lastKey, setLastKey] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [error, setError] = useState(false)

    const fetchPage = useCallback(async (startKey?: string | null) => {
        if (!isAuthenticated) return
        setIsLoading(true)
        setError(false)
        try {
            const token = await getAccessTokenSilently()
            const resp = await getCustomerConversations(token, PAGE_SIZE, startKey)
            setItems(prev => startKey ? [...prev, ...resp.conversations] : resp.conversations)
            setLastKey(resp.lastEvaluatedKey)
            setHasMore(!!resp.lastEvaluatedKey)
        } catch {
            setError(true)
        } finally {
            setIsLoading(false)
        }
    }, [isAuthenticated, getAccessTokenSilently])

    // Load first page on mount / auth change
    useEffect(() => {
        fetchPage(null)
    }, [fetchPage])

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
                navigate('/')
            }
        } catch (err) {
            console.error('Failed to archive conversation:', err)
        }
    }

    const groupedItems = useMemo(() => groupConversations(items), [items])

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                History
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
            ) : error ? (
                <div className={styles.emptyState}>Failed to load history</div>
            ) : items.length === 0 ? (
                <div className={styles.emptyState}>No conversations yet</div>
            ) : (
                <div className={styles.list} aria-label="Conversation history">
                    {groupedItems.map(group => (
                        <div key={group.label} className={styles.group}>
                            <div className={styles.groupHeader}>{group.label}</div>
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
                                                        <div className={styles.vendorIcons}>
                                                            {[...(conv.vendors || [])].sort().map((v, idx) => {
                                                                if (v === AIVendor.OPENAI) return <CollapsedOpenAIBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                if (v === AIVendor.CLAUDE) return <CollapsedClaudeBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                if (v === AIVendor.GEMINI) return <CollapsedGeminiBrandName key={idx} size={11} className={styles.vendorIcon} />
                                                                return null
                                                            })}
                                                        </div>
                                                        <span className={styles.itemLabel}>{label}</span>
                                                    </div>
                                                    <div className={styles.itemDetails}>
                                                        {conv.updatedAt && (
                                                            <span className={styles.timestamp}>
                                                                {new Date(conv.updatedAt).toLocaleString([], {
                                                                    year: 'numeric',
                                                                    month: 'short',
                                                                    day: 'numeric',
                                                                    hour: '2-digit',
                                                                    minute: '2-digit'
                                                                })}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>
                                            <button
                                                className={styles.archiveBtn}
                                                onClick={(e) => handleArchive(e, conv.conversationId)}
                                                title="Archive conversation"
                                                aria-label="Archive conversation"
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
                    {isLoading ? 'Loading…' : 'Load more'}
                </button>
            )}
        </div>
    )
}
