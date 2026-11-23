import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
    ConversationWidget,
    ConversationWidgetProvider,
    ConversationWidgetContextValue
} from '@genflowly/component-library'
import { useConversation, useConversationUI } from '../../../../context/ConversationContext'
import { useAuth } from '../../../../context/AuthContext'
import { useAI } from '../../../../context/AIContext'
import { useLayout } from '../../../../context/LayoutContext'
import { useToast } from '../../../../context/ToastContext'
import { uploadAttachment, getAttachmentViewUrl } from '../../../../services/attachmentService'
import { getLearnedFacts, deleteMemoryFact } from '../../../../services/learnedFactsService'
import { useVendorDisplayNames } from '../../../../hooks/useVendorDisplayNames'
import InstructionPickerModal from '../../../common/InstructionPickerModal/InstructionPickerModal'
import { RunHitlBanner } from './RunHitlBanner'
import NewChatProjectHint from './NewChatProjectHint'
import InstructionChip from './InstructionChip'
import { memoryPath, memoryInferencePath } from '../../../../pages/MemoryPage/memoryPaths'

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
    const { setSelectedInstructionId, setSystemPrompt } = useAI()
    const { isChatSidebarExpanded, isAiDockExpanded } = useLayout()
    const { showToast } = useToast()
    const getVendorDisplayName = useVendorDisplayNames()
    const [isPickerOpen, setPickerOpen] = useState(false)
    const canCompose = conversation.conversationRole !== 'VIEW'
    const navigate = useNavigate()

    const memoryNavigation = useMemo(() => ({
        openMemory: (memoryId: string) => navigate(memoryPath(memoryId)),
        openMemoryInference: (memoryId: string, runId: string) =>
            navigate(memoryInferencePath(memoryId, runId)),
        openMemoryPage: () => navigate('/memory'),
    }), [navigate])

    const composer = useMemo(() => ({
        controls: <InstructionChip onClick={() => setPickerOpen(true)} />,
        canCompose,
    }), [canCompose])

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
            getVendorDisplayName,
            ...memoryNavigation,
        },
        layout: { isLeftSidebarExpanded: isChatSidebarExpanded, isRightSidebarExpanded: isAiDockExpanded },
        showToast,
        composer,
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
        memoryNavigation,
        isChatSidebarExpanded,
        isAiDockExpanded,
        showToast,
        composer,
    ])

    return (
        <>
            <ConversationWidgetProvider value={value}>
                <ConversationWidget />
                <RunHitlBanner />
                <NewChatProjectHint />
            </ConversationWidgetProvider>
            <InstructionPickerModal
                isOpen={isPickerOpen}
                onClose={() => setPickerOpen(false)}
                onSelect={(instruction) => {
                    setSelectedInstructionId(instruction.id)
                    setSystemPrompt(instruction.instruction)
                    setPickerOpen(false)
                }}
            />
        </>
    )
}
