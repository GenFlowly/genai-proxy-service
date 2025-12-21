import React from 'react'
import { useAI } from '../../../context/AIContext'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../../widgets/TokenCounter/TokenCounter'
import styles from './RightSidebar.module.scss'

export default function RightSidebar(): React.ReactElement {
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
            <button
                onClick={toggleRightSidebar}
                className={styles.collapseButton}
                title={isRightSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}
            >
                {isRightSidebarExpanded ? (
                    <Icon src={ICONS.ALT_ARROW_RIGHT} size={20} />
                ) : (
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={20} />
                )}
            </button>

            {!collapsed && <h3 className={styles.title}>AI Configuration</h3>}

            {/* Vendor selection area */}
            <div className={styles.section}>
                {!collapsed && <h4 className={styles.sectionTitle}>Vendors</h4>}
                <AIVendorWidget collapsed={collapsed} />
            </div>


            {!collapsed && (
                <div className={styles.section}>
                    <h4 className={styles.sectionTitle}>Token Usage</h4>
                    <TokenCounter />
                </div>
            )}

        </div>
    )
}
