import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './RightSidebar.module.scss'
import { RightSidebarMobileModal } from '@genflowly/component-library'
import { useWidgetResolver } from '../../../hooks/useWidgetResolver'
import { useWindowSize } from '../../../hooks/useWindowSize'

interface RightSidebarProps {
    widgetIds: string[]
    'data-testid'?: string
}

export default function RightSidebar({ widgetIds, 'data-testid': testId }: RightSidebarProps): React.ReactElement | null {
    const { t } = useTranslation()
    const { isRightSidebarExpanded, toggleRightSidebar } = useLayout()
    const collapsed = !isRightSidebarExpanded
    const widgets = useWidgetResolver(widgetIds)
    const { width } = useWindowSize()
    const isMobile = width <= 768

    const widgetContent = widgets.map(widget => (
        <widget.component key={widget.id} />
    ))

    // 📱 Mobile: the sidebar is a full-screen modal on the same page,
    // so widgets keep access to the page's contexts and state.
    if (isMobile) {
        if (collapsed) return null
        return (
            <RightSidebarMobileModal onClose={toggleRightSidebar} data-testid={testId}>
                {widgetContent}
            </RightSidebarMobileModal>
        )
    }

    return (
        <div className={`${styles.sidebarWrapper} ${collapsed ? styles.collapsed : ''}`} data-testid={testId || "right-sidebar"}>
            <div className={styles.sidebarContent}>
                {widgetContent}
            </div>

            <button
                onClick={toggleRightSidebar}
                className={styles.collapseButton}
                title={isRightSidebarExpanded ? t("layout.rightSidebar.collapseSidebar") : t("layout.rightSidebar.expandSidebar")}
                data-testid="right-sidebar-toggle"
            >
                {isRightSidebarExpanded ? (
                    <Icon src={ICONS.ALT_ARROW_RIGHT} size={15} />
                ) : (
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={15} />
                )}
            </button>
        </div>
    )
}
