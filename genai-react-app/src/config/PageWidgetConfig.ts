export type PageId = 'CHAT_PAGE' | 'MEMORY_PAGE' | 'SETTINGS_PAGE' | 'AGENTS_PAGE'

export interface PageConfig {
    pageId: PageId
    leftSidebar: string[]
    rightSidebar: string[]
    centerSection: string[]
}

export const PAGE_WIDGET_CONFIG: PageConfig[] = [
    {
        pageId: 'CHAT_PAGE',
        leftSidebar: ['CONVERSATION_HISTORY_SIDEBAR_WIDGET', 'THREAD_LIST'],
        rightSidebar: ['NEW_CHAT', 'AI_VENDOR', 'TOKEN_COUNTER'],
        centerSection: ['INSTRUCTION_WIDGET', 'CONVERSATION_LIST'],
    },
    {
        pageId: 'MEMORY_PAGE',
        leftSidebar: ['SAVED_NOTES_WIDGET'],
        rightSidebar: [],
        centerSection: ['NOTES_WIDGET'],
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
