import React from 'react'
import { useSidebarMenu } from '../../../../context/SidebarMenuContext'
import { SIDEBAR_MENU_REGISTRY, SidebarMenuItem } from '../../../../config/SidebarMenuConfig'
import { useLayout } from '../../../../context/LayoutContext'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import Tooltip from '../../../common/Tooltip/Tooltip'
import styles from './SidebarMenu.module.scss'

export default function SidebarMenu(): React.ReactElement {
    const { activeWidgetId, setActiveWidgetId, pageId } = useSidebarMenu()
    const { isLeftSidebarExpanded } = useLayout()

    const config = pageId ? SIDEBAR_MENU_REGISTRY.find(m => m.pageId === pageId) : undefined
    const menuItems = config?.items || []
    const headerLabel = config?.header || ''


    const header = (
        <div style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {headerLabel}
        </div>
    )

    const menuItemsContent = (
        <div className={`${styles.menuContainer} ${!isLeftSidebarExpanded ? styles.collapsed : ''}`}>
            {menuItems.map((item: SidebarMenuItem) => {
                const { widgetId, label } = item
                const isActive = activeWidgetId === widgetId

                const menuItem = (
                    <button
                        key={widgetId}
                        className={`${styles.menuItem} ${isActive ? styles.active : ''}`}
                        onClick={() => setActiveWidgetId(widgetId)}
                    >
                        <span className={styles.label}>{label}</span>
                    </button>
                )

                if (!isLeftSidebarExpanded) {
                    return (
                        <Tooltip key={widgetId} content={label} position="right">
                            {menuItem}
                        </Tooltip>
                    )
                }

                return menuItem
            })}
        </div>
    )

    return (
        <SidebarWidgetContainer
            header={header}
            collapsedContent={<></>}
            isCollapsed={!isLeftSidebarExpanded}
        >
            {menuItemsContent}
        </SidebarWidgetContainer>
    )
}
