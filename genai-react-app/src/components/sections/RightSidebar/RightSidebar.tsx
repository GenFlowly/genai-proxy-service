import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import AIVendorWidget from '../../widgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../../widgets/TokenCounter/TokenCounter'
import styles from './RightSidebar.module.scss'
import { useConversation } from '../../../context/ConversationContext'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'

export default function RightSidebar(): React.ReactElement {
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const { resetConversation } = useConversation()
    const collapsed = !isRightSidebarExpanded

    return (
        <div className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
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

            {/* New Chat Button */}
            {!collapsed && (
                <div style={{ alignSelf: 'stretch' }}>
                    <MultiPurposeButton
                        label="New Chat"
                        onClick={resetConversation}
                        icon={ICONS.PLUS}
                    />
                </div>
            )}

            {/* Vendor selection area */}
            <div className={styles.section}>
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
