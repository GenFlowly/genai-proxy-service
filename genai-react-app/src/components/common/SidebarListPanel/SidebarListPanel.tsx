import React, { useCallback, useEffect, useState, ReactNode } from 'react'
import styles from './SidebarListPanel.module.scss'

export interface SidebarListItemAction {
    icon: ReactNode
    label: string
    onClick: (e: React.MouseEvent) => void
    testId?: string
}

export interface SidebarListItem {
    id: string
    label: string
    // Extra content for the item's second line (timestamps, badges, ...)
    details?: ReactNode
    isActive?: boolean
    // aria-current value applied when the item is active ('page' for nav lists)
    ariaCurrent?: 'page' | 'true'
    onSelect: () => void
    // Optional trailing button (archive, delete, ...) shown at the row's right edge
    action?: SidebarListItemAction
    testId?: string
}

export interface SidebarListGroup {
    id: string
    label: string
    items: SidebarListItem[]
}

export interface SidebarListPanelProps {
    title: string
    groups: SidebarListGroup[]
    isLoading: boolean
    hasError: boolean
    errorText: string
    emptyText: string
    listAriaLabel?: string
    // Rendered below the list (e.g. a "Load more" pagination button)
    footer?: ReactNode
    'data-testid'?: string
    testIds?: {
        list?: string
        loading?: string
        error?: string
        empty?: string
    }
}

// Styled pagination button for the panel's footer slot
export function SidebarListLoadMore({
    label,
    onClick,
    disabled,
    testId,
}: {
    label: string
    onClick: () => void
    disabled?: boolean
    testId?: string
}) {
    return (
        <button
            className={styles.loadMore}
            onClick={onClick}
            disabled={disabled}
            data-testid={testId}
        >
            {label}
        </button>
    )
}

/**
 * Shared sidebar list UI: header, skeleton/error/empty states and a grouped,
 * scrollable list of selectable items. Data fetching and item semantics stay
 * with the caller (conversation history, saved notes, ...).
 */
export default function SidebarListPanel({
    title,
    groups,
    isLoading,
    hasError,
    errorText,
    emptyText,
    listAriaLabel,
    footer,
    'data-testid': testId,
    testIds,
}: SidebarListPanelProps) {
    const isEmpty = groups.every(group => group.items.length === 0)

    // Scrollbar is invisible until the list is actually scrolling
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
        <div className={styles.container} data-testid={testId}>
            <div className={styles.header}>
                {title}
            </div>

            {isLoading && isEmpty ? (
                <div className={styles.skeleton} data-testid={testIds?.loading}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div
                            key={i}
                            className={styles.skeletonItem}
                            style={{ width: `${70 + (i % 3) * 10}%` }}
                        />
                    ))}
                </div>
            ) : hasError && isEmpty ? (
                // A failed background refresh keeps showing the stale list;
                // the error state is only for having nothing at all to show
                <div className={styles.emptyState} data-testid={testIds?.error}>{errorText}</div>
            ) : isEmpty ? (
                <div className={styles.emptyState} data-testid={testIds?.empty}>{emptyText}</div>
            ) : (
                <div
                    className={`${styles.list} ${isScrolling ? styles.scrolling : ''}`}
                    aria-label={listAriaLabel}
                    onScroll={handleScroll}
                    data-testid={testIds?.list}
                >
                    {groups.map(group => (
                        <div key={group.id} className={styles.group}>
                            <div className={styles.groupHeader}>{group.label}</div>
                            <ul className={styles.groupList}>
                                {group.items.map(item => (
                                    <li key={item.id} className={styles.itemRow}>
                                        <button
                                            className={`${styles.item} ${item.isActive ? styles.active : ''}`}
                                            onClick={item.onSelect}
                                            title={item.label}
                                            aria-current={item.isActive ? (item.ariaCurrent ?? 'true') : undefined}
                                            data-testid={item.testId}
                                        >
                                            <div className={styles.itemContent}>
                                                <div className={styles.itemHeader}>
                                                    <span className={styles.itemLabel}>{item.label}</span>
                                                </div>
                                                {item.details != null && (
                                                    <div className={styles.itemDetails}>
                                                        {item.details}
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                        {item.action && (
                                            <button
                                                className={styles.actionBtn}
                                                onClick={item.action.onClick}
                                                title={item.action.label}
                                                aria-label={item.action.label}
                                                data-testid={item.action.testId}
                                            >
                                                {item.action.icon}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}

            {footer}
        </div>
    )
}
