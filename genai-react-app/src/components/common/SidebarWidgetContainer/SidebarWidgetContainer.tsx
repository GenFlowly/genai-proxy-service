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

    /** Optional test id */
    'data-testid'?: string
}

export default function SidebarWidgetContainer({
    children,
    collapsedContent,
    header,
    headerCollapsed,
    'data-testid': testId
}: SidebarWidgetContainerProps) {
    const { isRightSidebarExpanded } = useLayout()
    const collapsed = !isRightSidebarExpanded

    if (collapsed) {
        return (
            <div className={styles.collapsedContainer} data-testid={testId} data-collapsed="true">
                {headerCollapsed && (
                    <div className={styles.collapsedHeader} data-testid={testId ? `${testId}-header-collapsed` : undefined}>
                        {headerCollapsed}
                    </div>
                )}
                <div className={styles.collapsedContent} data-testid={testId ? `${testId}-content-collapsed` : undefined}>
                    {collapsedContent}
                </div>
            </div>
        )
    }

    // Expanded View
    return (
        <div className={styles.container} data-testid={testId} data-collapsed="false">
            {header && (
                <div className={styles.header} data-testid={testId ? `${testId}-header` : undefined}>
                    {header}
                </div>
            )}
            <div className={styles.content} data-testid={testId ? `${testId}-content` : undefined}>
                {children}
            </div>
        </div>
    )
}
