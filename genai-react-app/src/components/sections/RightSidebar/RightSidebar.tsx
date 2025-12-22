import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../../widgets/TokenCounter/TokenCounter'
import styles from './RightSidebar.module.scss'
import NewChatWidget from '../../widgets/NewChatWidget/NewChatWidget'

export default function RightSidebar(): React.ReactElement {
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={`${styles.sidebarWrapper} ${collapsed ? styles.collapsed : ''}`}>
            <button
                onClick={toggleRightSidebar}
                className={styles.collapseButton}
                title={isRightSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}
            >
                {isRightSidebarExpanded ? (
                    <Icon src={ICONS.ALT_ARROW_RIGHT} size={15} />
                ) : (
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={15} />
                )}
            </button>

            <div className={styles.sidebarContent}>
                {/* New Chat Widget */}
                {!collapsed && (
                    <div className={styles.section}>
                        <NewChatWidget />
                    </div>
                )}

                {/* Vendor selection area */}
                <div className={styles.section}>
                    <AIVendorWidget collapsed={collapsed} />
                </div>


                {!collapsed && (
                    <div className={styles.section}>
                        <TokenCounter />
                    </div>
                )}
            </div>
        </div>
    )
}
