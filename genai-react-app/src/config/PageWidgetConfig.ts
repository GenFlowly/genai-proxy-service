export type PageId = 'CHAT_PAGE' | 'SETTINGS_PAGE' | 'AGENTS_PAGE'

export interface PageConfig {
    pageId: PageId
    leftSidebar: string[]
    rightSidebar: string[]
    centerSection: string[]
}

export const PAGE_WIDGET_CONFIG: PageConfig[] = [
    {
        pageId: 'CHAT_PAGE',
        // The chat page composes its sidebar and AI settings dock directly
        leftSidebar: [],
        rightSidebar: [],
        centerSection: ['CONVERSATION_LIST'],
    },
    {
        pageId: 'SETTINGS_PAGE',
        leftSidebar: ['SIDEBAR_MENU'],
        rightSidebar: [],
        centerSection: ['PROFILE_SETTINGS', 'CONFIGURE_AI_VENDOR_SETTINGS', 'DATABASE_CONNECTIONS_SETTINGS'],
    },
    {
        pageId: 'AGENTS_PAGE',
        leftSidebar: [],
        rightSidebar: [],
        centerSection: [],
    },
]

export const getPageConfig = (pageId: PageId): PageConfig => {
    return PAGE_WIDGET_CONFIG.find(c => c.pageId === pageId) || PAGE_WIDGET_CONFIG[0]
}
