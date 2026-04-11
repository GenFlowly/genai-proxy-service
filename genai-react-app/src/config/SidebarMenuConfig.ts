import { PageId } from './PageWidgetConfig'

export interface SidebarMenuItem {
    widgetId: string
    label: string
}

export interface SidebarMenuObject {
    pageId: PageId
    header?: string
    items: SidebarMenuItem[]
}

export const SIDEBAR_MENU_REGISTRY: SidebarMenuObject[] = [
    {
        pageId: 'SETTINGS_PAGE',
        header: '',
        items: [
            { widgetId: 'CONFIGURE_AI_VENDOR_SETTINGS', label: 'AI Vendor API Keys' },
            { widgetId: 'DATABASE_CONNECTIONS_SETTINGS', label: 'Database Settings' }
        ]
    }
]
