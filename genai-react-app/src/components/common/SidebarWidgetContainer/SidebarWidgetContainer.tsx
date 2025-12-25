import React from 'react'
import styles from './SidebarWidgetContainer.module.scss'
import { useLayout } from '../../../context/LayoutContext'

interface SidebarWidgetContainerProps {
    /** The expanded content */
    children: React.ReactNode

    /** Custom collapsed content. */
    collapsedContent: React.ReactNode

    /** Optional header content for expanded state */
    header?: React.ReactNode

    /** Optional header content for collapsed state */
    headerCollapsed?: React.ReactNode
}

export default function SidebarWidgetContainer({
    children,
    collapsedContent,
    header,
    headerCollapsed
}: SidebarWidgetContainerProps) {
    const { isRightSidebarExpanded } = useLayout()
    const collapsed = !isRightSidebarExpanded

    if (collapsed) {
        return (
            <div className={styles.collapsedContainer}>
                {headerCollapsed && (
                    <div className={styles.collapsedHeader}>
                        {headerCollapsed}
                    </div>
                )}
                <div className={styles.collapsedContent}>
                    {collapsedContent}
                </div>
            </div>
        )
    }

    // Expanded View
    return (
        <div className={styles.container}>
            {header && (
                <div className={styles.header}>
                    {header}
                </div>
            )}
            <div className={styles.content}>
                {children}
            </div>
        </div>
    )
}
