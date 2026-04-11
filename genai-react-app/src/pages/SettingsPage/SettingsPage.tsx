import React, { useEffect } from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { useLayout } from '../../context/LayoutContext'
import LeftSidebar from '../../components/sections/LeftSidebar/LeftSidebar'
import CenterSection from '../../components/sections/CenterSection/CenterSection'
import { getPageConfig } from '../../config/PageWidgetConfig'
import { SidebarMenuProvider } from '../../context/SidebarMenuContext'
import { SIDEBAR_MENU_REGISTRY } from '../../config/SidebarMenuConfig'
import { usePageTitle } from '../../hooks/usePageTitle'

function SettingsPageInner({ config }: { config: ReturnType<typeof getPageConfig> }): React.ReactElement {
    usePageTitle()
    return (
        <div className={styles.layout}>
            <LeftSidebar widgetIds={config.leftSidebar} />
            <div className={styles.content}>
                <CenterSection widgetIds={config.centerSection} />
            </div>
        </div>
    )
}

export default function SettingsPage(): React.ReactElement {
    const { setLeftSidebarExpanded } = useLayout()

    useEffect(() => {
        setLeftSidebarExpanded(true)
    }, [setLeftSidebarExpanded])

    const config = getPageConfig('SETTINGS_PAGE')
    const sidebarConfig = SIDEBAR_MENU_REGISTRY.find(m => m.pageId === 'SETTINGS_PAGE')
    const initialWidgetId = sidebarConfig?.items[0]?.widgetId || null

    return (
        <SidebarMenuProvider pageId="SETTINGS_PAGE" initialWidgetId={initialWidgetId}>
            <div className={styles.page}>
                <Navbar />
                <SettingsPageInner config={config} />
            </div>
        </SidebarMenuProvider>
    )
}