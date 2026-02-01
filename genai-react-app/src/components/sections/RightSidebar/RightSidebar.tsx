import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './RightSidebar.module.scss'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'

interface RightSidebarProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function RightSidebar({ widgetIds, 'data-testid': testId }: RightSidebarProps): React.ReactElement {
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded
    const widgets = useWidgetResolver(widgetIds)

    return (
        <div className={`${styles.sidebarWrapper} ${collapsed ? styles.collapsed : ''}`} data-testid={testId || "right-sidebar"}>
            <button
                onClick={toggleRightSidebar}
                className={styles.collapseButton}
                title={isRightSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}
                data-testid="right-sidebar-toggle"
            >
                {isRightSidebarExpanded ? (
                    <Icon src={ICONS.ALT_ARROW_RIGHT} size={15} />
                ) : (
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={15} />
                )}
            </button>

            <div className={styles.sidebarContent}>
                {widgets.map(widget => (
                    <widget.component key={widget.id} />
                ))}
            </div>
        </div>
    )
}
