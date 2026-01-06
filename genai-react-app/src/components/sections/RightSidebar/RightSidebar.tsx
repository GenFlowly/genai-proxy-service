import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import AIVendorWidget from '../../widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../../widgets/SidebarWidgets/TokenCounter/TokenCounter'
import styles from './RightSidebar.module.scss'
import NewChatWidget from '../../widgets/SidebarWidgets/NewChatWidget/NewChatWidget'

export default function RightSidebar(): React.ReactElement {
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={`${styles.sidebarWrapper} ${collapsed ? styles.collapsed : ''}`} data-testid="right-sidebar">
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
                <NewChatWidget />
                <AIVendorWidget />
                <TokenCounter />
            </div>
        </div>
    )
}
