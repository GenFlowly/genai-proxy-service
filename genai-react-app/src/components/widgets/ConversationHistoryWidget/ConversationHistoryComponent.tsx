import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { getCustomerConversations, archiveConversation } from '../../../services/conversationHistoryService'
import { ConversationSummary } from '../../../models/conversationHistory.models'
import styles from './ConversationHistory.module.scss'

const PAGE_SIZE = 15

function MessageIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v7a1.5 1.5 0 01-1.5 1.5H9l-3 2.5V12H3.5A1.5 1.5 0 012 10.5v-7z"
                fill="currentColor"
            />
        </svg>
    )
}

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

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <MessageIcon className={styles.itemIcon} />
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
                <ul className={styles.list} aria-label="Conversation history">
                    {items.map(conv => {
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
                                    <MessageIcon className={styles.itemIcon} />
                                    <span className={styles.itemLabel}>{label}</span>
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
