export type PageId = 'CHAT_PAGE' | 'SETTINGS_PAGE' | 'AGENTS_PAGE'

export interface PageConfig {
    pageId: PageId
    centerSection: string[]
}

export const PAGE_WIDGET_CONFIG: PageConfig[] = [
    {
        pageId: 'CHAT_PAGE',
        centerSection: ['CONVERSATION_LIST'],
    },
    {
        pageId: 'SETTINGS_PAGE',
        centerSection: ['PROFILE_SETTINGS', 'CONFIGURE_AI_VENDOR_SETTINGS', 'DATABASE_CONNECTIONS_SETTINGS'],
    },
    {
        pageId: 'AGENTS_PAGE',
        centerSection: [],
    },
]

export const getPageConfig = (pageId: PageId): PageConfig => {
    return PAGE_WIDGET_CONFIG.find(c => c.pageId === pageId) || PAGE_WIDGET_CONFIG[0]
}
