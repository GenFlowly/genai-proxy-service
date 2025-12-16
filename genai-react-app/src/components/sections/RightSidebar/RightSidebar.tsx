import React from 'react'
import { useAI } from '../../../context/AIContext'
import { useLayout } from '../../../context/LayoutContext'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../../widgets/TokenCounter/TokenCounter'
import styles from './RightSidebar.module.scss'

export default function RightSidebar(): React.ReactElement {
    const { config } = useAI()
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={styles.sidebar}>
            <button
                onClick={toggleRightSidebar}
                className={styles.collapseButton}
                title={isRightSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}
            >
                {isRightSidebarExpanded ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
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
