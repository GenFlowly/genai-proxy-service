import React from 'react'
import styles from './Breadcrumbs.module.scss'

export interface BreadcrumbItem {
    label: string
    // Invoked when the crumb is clicked (navigate to that level).
    onClick?: () => void
}

interface BreadcrumbsProps {
    items: BreadcrumbItem[]
    className?: string
    'data-testid'?: string
}

/**
 * Generic breadcrumb trail, e.g. "Menu > Settings > Profile".
 * Every item with an onClick is clickable; the last item is marked as the
 * current level (aria-current) but remains clickable if it has an onClick.
 */
export default function Breadcrumbs({ items, className = '', 'data-testid': testId }: BreadcrumbsProps) {
    return (
        <nav
            className={`${styles.breadcrumbs} ${className}`}
            aria-label="Breadcrumbs"
            data-testid={testId || 'breadcrumbs'}
        >
            {items.map((item, index) => {
                const isCurrent = index === items.length - 1
                return (
                    <React.Fragment key={`${item.label}-${index}`}>
                        {index > 0 && <span className={styles.separator} aria-hidden="true">›</span>}
                        {item.onClick ? (
                            <button
                                className={`${styles.crumb} ${isCurrent ? styles.current : ''}`}
                                onClick={item.onClick}
                                aria-current={isCurrent ? 'page' : undefined}
                                data-testid={`breadcrumb-${item.label}`}
                            >
                                {item.label}
                            </button>
                        ) : (
                            <span
                                className={`${styles.crumb} ${isCurrent ? styles.current : ''}`}
                                aria-current={isCurrent ? 'page' : undefined}
                                data-testid={`breadcrumb-${item.label}`}
                            >
                                {item.label}
                            </span>
                        )}
                    </React.Fragment>
                )
            })}
        </nav>
    )
}
