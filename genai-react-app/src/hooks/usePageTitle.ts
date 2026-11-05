import { useEffect } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useSidebarMenu } from '../context/SidebarMenuContext'
import { SIDEBAR_MENU_REGISTRY } from '../config/SidebarMenuConfig'
import { APP_NAME } from '../constants/appName'

const DEFAULT_TITLE = APP_NAME

const ROUTE_TITLES: Record<string, string> = {
    '/chat': DEFAULT_TITLE,
    '/memory': `Memory | ${DEFAULT_TITLE}`,
}

const WIDGET_TITLES: Record<string, string> = {
    'CONFIGURE_AI_VENDOR_SETTINGS': `AI Vendor API Keys Settings`,
    'PROFILE_SETTINGS': `Profile Settings`,
    'DATABASE_CONNECTIONS_SETTINGS': `Database Settings`,
}

export const usePageTitle = () => {
    const location = useLocation()
    const { conversationId } = useParams()
    const { activeWidgetId } = useSidebarMenu()

    useEffect(() => {
        const path = location.pathname.replace(/\/chat\/.*/, '/chat')
        
        if (path === '/chat' && !conversationId) {
            document.title = `New Conversation | ${DEFAULT_TITLE}`
            return
        }

        // Active conversation: title was set by the stream — don't overwrite it
        if (path === '/chat' && conversationId) {
            return
        }

        if (path === '/settings') {
            // For settings, derive title from active sidebar widget
            if (activeWidgetId && WIDGET_TITLES[activeWidgetId]) {
                document.title = WIDGET_TITLES[activeWidgetId]
            } else {
                // Fall back to label of first settings item
                const settingsMenu = SIDEBAR_MENU_REGISTRY.find(m => m.pageId === 'SETTINGS_PAGE')
                const firstItem = settingsMenu?.items[0]
                const firstWidgetTitle = firstItem ? WIDGET_TITLES[firstItem.widgetId] : undefined
                document.title = firstWidgetTitle ?? `Settings | ${DEFAULT_TITLE}`
            }
            return
        }

        document.title = ROUTE_TITLES[path] ?? DEFAULT_TITLE
    }, [location.pathname, conversationId, activeWidgetId])
}
