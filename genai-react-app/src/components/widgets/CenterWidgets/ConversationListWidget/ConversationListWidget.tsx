import React, { useMemo } from 'react'
import {
    ConversationWidget,
    ConversationWidgetProvider,
    ConversationWidgetContextValue
} from '@genflowly/component-library'
import { useConversation, useConversationUI } from '../../../../context/ConversationContext'
import { useAuth } from '../../../../context/AuthContext'
import { useLayout } from '../../../../context/LayoutContext'
import { useToast } from '../../../../context/ToastContext'
import { uploadAttachment, getAttachmentViewUrl } from '../../../../services/attachmentService'
import { getLearnedFacts, deleteMemoryFact } from '../../../../services/learnedFactsService'
import { useVendorDisplayNames } from '../../../../hooks/useVendorDisplayNames'
import { RunHitlBanner } from './RunHitlBanner'

/**
 * Adapter between the app's contexts/services and the shared
 * ConversationWidget from @genflowly/component-library (where the widget's
 * components moved). The app remains the owner of conversation state, auth,
 * and backend calls; the library renders the conversation surface.
 */
export default function ConversationListWidget() {
    const conversation = useConversation()
    const conversationUI = useConversationUI()
    const {
        isAuthenticated,
        customerId,
        customerName,
        customerPicture,
        user,
        aiVendorAPIKeyStatusList,
        getAccessTokenSilently
    } = useAuth()
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { showToast } = useToast()
    const getVendorDisplayName = useVendorDisplayNames()

    const value = useMemo<ConversationWidgetContextValue>(() => ({
        conversation,
        conversationUI,
        auth: {
            isAuthenticated,
            customerId,
            customerName,
            customerPicture,
            user,
            aiVendorAPIKeyStatusList,
            getAccessTokenSilently
        },
        services: {
            uploadAttachment,
            getAttachmentViewUrl,
            getLearnedFacts,
            deleteMemoryFact,
            getVendorDisplayName
        },
        layout: { isLeftSidebarExpanded, isRightSidebarExpanded },
        showToast
    }), [
        conversation,
        conversationUI,
        isAuthenticated,
        customerId,
        customerName,
        customerPicture,
        user,
        aiVendorAPIKeyStatusList,
        getAccessTokenSilently,
        getVendorDisplayName,
        isLeftSidebarExpanded,
        isRightSidebarExpanded,
        showToast
    ])

    return (
        <ConversationWidgetProvider value={value}>
            <ConversationWidget />
            <RunHitlBanner />
        </ConversationWidgetProvider>
    )
}
