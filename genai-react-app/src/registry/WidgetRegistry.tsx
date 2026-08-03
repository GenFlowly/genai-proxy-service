import React, { lazy } from 'react'

import InstructionSidebarWidget from '../components/widgets/SidebarWidgets/InstructionSidebarWidget/InstructionSidebarWidget'
import ConversationHistorySidebarWidget from '../components/widgets/SidebarWidgets/ConversationHistorySidebarWidget/ConversationHistorySidebarWidget'
// @ts-ignore
import InstructionWidget from '../components/widgets/InstructionWidget/InstructionWidget'
import ThreadWidget from '../components/widgets/SidebarWidgets/ThreadWidget/ThreadWidget'
import NewChatWidget from '../components/widgets/SidebarWidgets/NewChatWidget/NewChatWidget'
import AIVendorWidget from '../components/widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget'
import TokenCounter from '../components/widgets/SidebarWidgets/TokenCounter/TokenCounter'

import NotesWidget from '../components/widgets/CenterWidgets/NotesWidget/NotesWidget'
import ConversationListWidget from '../components/widgets/CenterWidgets/ConversationListWidget/ConversationListWidget'
import ConfigureAIVendorSettingsWidget from '../components/widgets/ConfigureAIVendorSettingsWidget/ConfigureAIVendorSettingsWidget'
import DatabaseConnectionsSettingsWidget from '../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget'
import SidebarMenu from '../components/widgets/SidebarWidgets/SidebarMenu/SidebarMenu'
import ConversationHistoryComponent from '../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent'

export interface WidgetContext {
    userId?: string
    isPaid?: boolean
    // Add other user context properties here
}

export interface WidgetDefinition {
    id: string
    component: React.ComponentType<any>
    name?: string
    isVisible?: (context: WidgetContext) => boolean
}

export const WIDGET_REGISTRY: Record<string, WidgetDefinition> = {
    'INSTRUCTION_SIDEBAR': {
        id: 'INSTRUCTION_SIDEBAR',
        component: InstructionSidebarWidget,
    },
    'CONVERSATION_HISTORY_SIDEBAR_WIDGET': {
        id: 'CONVERSATION_HISTORY_SIDEBAR_WIDGET',
        component: ConversationHistorySidebarWidget,
    },
    'THREAD_LIST': {
        id: 'THREAD_LIST',
        component: ThreadWidget,
    },
    'NEW_CHAT': {
        id: 'NEW_CHAT',
        component: NewChatWidget,
    },
    'AI_VENDOR': {
        id: 'AI_VENDOR',
        component: AIVendorWidget,
    },
    'TOKEN_COUNTER': {
        id: 'TOKEN_COUNTER',
        component: TokenCounter,
        // Example: Only visible if paid (commented out for now, to demonstrate compatibility)
        // isVisible: (context) => !!context.isPaid 
    },
    // Center Section Widgets
    'INSTRUCTION_WIDGET': {
        id: 'INSTRUCTION_WIDGET',
        component: InstructionWidget,
    },
    'CONVERSATION_LIST': {
        id: 'CONVERSATION_LIST',
        component: ConversationListWidget,
    },
    'NOTES_WIDGET': {
        id: 'NOTES_WIDGET',
        component: NotesWidget,
    },
    'CONFIGURE_AI_VENDOR_SETTINGS': {
        id: 'CONFIGURE_AI_VENDOR_SETTINGS',
        component: ConfigureAIVendorSettingsWidget,
        name: 'AI Vendor API Keys',
    },
    'PROFILE_SETTINGS': {
        id: 'PROFILE_SETTINGS',
        name: 'Profile Settings',
        component: lazy(() => import('../components/widgets/ProfileSettingsWidget/ProfileSettingsWidget'))
    },
    'DATABASE_CONNECTIONS_SETTINGS': {
        id: 'DATABASE_CONNECTIONS_SETTINGS',
        component: DatabaseConnectionsSettingsWidget,
        name: 'Database Settings',
    },
    'SIDEBAR_MENU': {
        id: 'SIDEBAR_MENU',
        component: SidebarMenu,
    },
    'CONVERSATION_HISTORY': {
        id: 'CONVERSATION_HISTORY',
        component: ConversationHistoryComponent,
        name: 'Conversation History',
    },
}
