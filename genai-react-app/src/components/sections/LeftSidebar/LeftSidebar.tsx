import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import styles from './LeftSidebar.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'
import { useWindowSize } from '../../../hooks/useWindowSize'

interface LeftSidebarProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function LeftSidebar({ widgetIds, 'data-testid': testId }: LeftSidebarProps): React.ReactElement | null {
    const { isLeftSidebarExpanded, isLeftSidebarMinimized } = useLayout()
    const collapsed = !isLeftSidebarExpanded
    const widgets = useWidgetResolver(widgetIds)

    const { width } = useWindowSize()
    const isMobile = width <= 768 // our standard mobile breakpoint

    if (isMobile) {
        return null; // LeftSidebar widgets are not shown on mobile, the global mobile menu takes over
    }

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''} ${isLeftSidebarMinimized ? styles.minimized : ''}`} data-testid={testId || "left-sidebar"}>
            <div className={styles.sidebarContent}>
                {widgets.map(widget => (
                    <widget.component key={widget.id} />
                ))}
            </div>
        </aside>
    )
}
