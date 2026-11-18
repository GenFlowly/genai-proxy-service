import React, { lazy } from 'react'

import ConversationListWidget from '../components/widgets/CenterWidgets/ConversationListWidget/ConversationListWidget'
import ConfigureAIVendorSettingsWidget from '../components/widgets/ConfigureAIVendorSettingsWidget/ConfigureAIVendorSettingsWidget'
import DatabaseConnectionsSettingsWidget from '../components/widgets/DatabaseConnectionsSettingsWidget/DatabaseConnectionsSettingsWidget'
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
    // Center Section Widgets
    'CONVERSATION_LIST': {
        id: 'CONVERSATION_LIST',
        component: ConversationListWidget,
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
    'CONVERSATION_HISTORY': {
        id: 'CONVERSATION_HISTORY',
        component: ConversationHistoryComponent,
        name: 'Conversation History',
    },
}
