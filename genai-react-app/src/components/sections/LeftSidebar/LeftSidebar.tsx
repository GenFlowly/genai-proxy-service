import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import styles from './LeftSidebar.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'
import { useResponsiveBreakpoints } from '../../../hooks/useResponsiveBreakpoints'

interface LeftSidebarProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function LeftSidebar({ widgetIds, 'data-testid': testId }: LeftSidebarProps): React.ReactElement | null {
    const { isLeftSidebarExpanded, isLeftSidebarMinimized } = useLayout()
    const collapsed = !isLeftSidebarExpanded
    const widgets = useWidgetResolver(widgetIds)

    const { isNarrow } = useResponsiveBreakpoints()

    if (isNarrow) {
        return null; // LeftSidebar widgets aren't shown below isNarrow — the global mobile menu takes over
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
