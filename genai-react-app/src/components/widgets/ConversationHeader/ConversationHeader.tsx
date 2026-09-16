import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth0 } from '@auth0/auth0-react'
import ShareModal, { VisibilityMode } from '../../common/ShareModal/ShareModal'
import InstructionPickerModal from '../../common/InstructionPickerModal/InstructionPickerModal'
import { PillButton } from '@genflowly/component-library'
import { PageHeader, pageHeaderStyles } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useAI } from '../../../context/AIContext'
import { useConversation } from '../../../context/ConversationContext'
import { useLayout } from '../../../context/LayoutContext'
import { useWindowSize } from '../../../hooks/useWindowSize'
import MobileHeader, { MobileHeaderMenuItem } from '../MobileHeader/MobileHeader'
import ConversationHistoryComponent from '../ConversationHistoryWidget/ConversationHistoryComponent'
import styles from './ConversationHeader.module.scss'
import { useToast } from '../../../context/ToastContext'
import {
    shareConversation,
    unshareConversation,
    getConversationSharedUsers,
} from '../../../services/conversationService'
import { SearchUserResponse } from '../../../models/user.models'
import { ICONS } from '../../../constants/icons'

export default function ConversationHeader(): React.ReactElement | null {
    const { t } = useTranslation()
    const { conversationId, conversationTitle, conversationRole, resetConversation } = useConversation()
    const { getAccessTokenSilently } = useAuth0()
    const { entitlements, customerInstructions } = useAuth()
    const { selectedInstructionId, setSelectedInstructionId, setSystemPrompt } = useAI()
    const { toggleRightSidebar } = useLayout()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    const [isPickerOpen, setPickerOpen] = useState(false)

    // Latest version of the instruction loaded into this conversation
    const loadedInstruction = useMemo(() => {
        if (!selectedInstructionId) return null
        const matching = (customerInstructions ?? []).filter(i => i.id === selectedInstructionId)
        return matching.sort((a, b) => b.version - a.version)[0] ?? null
    }, [selectedInstructionId, customerInstructions])
    const { showToast } = useToast()
    const [isShareModalOpen, setShareModalOpen] = useState(false)

    const isNewChat = !conversationId
    const canShare = conversationRole === 'OWNER' || conversationRole === 'EDIT'
    // Only offer sharing once a conversation is loaded — a new chat has
    // nothing to share yet
    const showShare = entitlements.canShare && !isNewChat && canShare
    const displayTitle = isNewChat ? t('conversation.conversationHeader.newChat') : (conversationTitle ?? t('conversation.conversationHeader.untitledConversation'))

    const handleShareSave = async (
        _mode: VisibilityMode,
        users: SearchUserResponse[],
        removedUsers: SearchUserResponse[]
    ) => {
        if (isNewChat) return
        try {
            const token = await getAccessTokenSilently()
            for (const user of users) {
                await shareConversation(token, conversationId, user.customerId, (user.role as 'VIEW' | 'EDIT') || 'VIEW')
            }
            for (const user of removedUsers) {
                await unshareConversation(token, conversationId, user.customerId)
            }
            showToast(t('conversation.conversationHeader.shareSettingsUpdated'))
        } catch (err) {
            console.error('Failed to update conversation share', err)
            showToast(t('conversation.conversationHeader.shareSettingsUpdateFailed'))
        }
    }

    const modals = (
        <>
            <InstructionPickerModal
                isOpen={isPickerOpen}
                onClose={() => setPickerOpen(false)}
                onSelect={(instruction) => {
                    setSelectedInstructionId(instruction.id)
                    setSystemPrompt(instruction.instruction)
                    setPickerOpen(false)
                }}
            />
            <ShareModal
                isOpen={isShareModalOpen}
                onClose={() => setShareModalOpen(false)}
                onSave={handleShareSave}
                entityId={conversationId}
                fetchSharedUsers={async (id) => {
                    const token = await getAccessTokenSilently()
                    return getConversationSharedUsers(token, id)
                }}
            />
        </>
    )

    // 📱 Mobile: no navbar/header band — a transparent overlay on the
    // full-screen content carries the title, instruction and page actions
    if (isMobile) {
        const menuItems: MobileHeaderMenuItem[] = [
            {
                label: t('conversation.conversationHeader.newChat'),
                onClick: resetConversation,
                'data-testid': 'new-chat-button',
            },
            ...(showShare ? [{
                label: t('conversation.conversationHeader.share'),
                onClick: () => setShareModalOpen(true),
                'data-testid': 'conversation-share-button',
            }] : []),
            {
                label: t('conversation.conversationHeader.aiConfig'),
                onClick: toggleRightSidebar,
                'data-testid': 'mobile-ai-config-button',
            },
        ]

        return (
            <MobileHeader
                title={displayTitle}
                subtitle={loadedInstruction ? (
                    <>
                        {loadedInstruction.icon && (
                            <span aria-hidden="true">{loadedInstruction.icon}</span>
                        )}
                        <span className={styles.instructionName}>
                            {loadedInstruction.name}
                        </span>
                    </>
                ) : (
                    <span className={styles.instructionName}>
                        {t('conversation.conversationHeader.chooseInstruction')}
                    </span>
                )}
                onSubtitleClick={() => setPickerOpen(true)}
                menuItems={menuItems}
                menuTitle={t('conversation.conversationHistory.title')}
                menuContent={<ConversationHistoryComponent />}
            >
                {modals}
            </MobileHeader>
        )
    }

    return (
        <PageHeader
            title={displayTitle}
            center={
                loadedInstruction ? (
                    <button
                        className={styles.instructionBadge}
                        title={loadedInstruction.name}
                        onClick={() => setPickerOpen(true)}
                        data-testid="loaded-instruction"
                    >
                        {loadedInstruction.icon && (
                            <span aria-hidden="true">{loadedInstruction.icon}</span>
                        )}
                        <span className={styles.instructionName}>
                            {loadedInstruction.name}
                        </span>
                    </button>
                ) : (
                    <button
                        className={`${styles.instructionBadge} ${styles.instructionBadgePlaceholder}`}
                        title={t('conversation.conversationHeader.chooseInstruction')}
                        onClick={() => setPickerOpen(true)}
                        data-testid="choose-instruction"
                    >
                        <span className={styles.instructionName}>
                            {t('conversation.conversationHeader.chooseInstruction')}
                        </span>
                    </button>
                )
            }
            actions={(
                <>
                    <PillButton
                        label={t('conversation.conversationHeader.newChat')}
                        icon={ICONS.PLUS}
                        className={pageHeaderStyles.actionButton}
                        onClick={resetConversation}
                        data-testid="new-chat-button"
                    />
                    {showShare && (
                        <PillButton
                            label={t('conversation.conversationHeader.share')}
                            icon={ICONS.SHARE}
                            className={pageHeaderStyles.actionButton}
                            onClick={() => setShareModalOpen(true)}
                            data-testid="conversation-share-button"
                        />
                    )}
                </>
            )}
        >
            {modals}
        </PageHeader>
    )
}
