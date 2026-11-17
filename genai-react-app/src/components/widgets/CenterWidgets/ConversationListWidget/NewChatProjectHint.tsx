import React from 'react'
import { useTranslation } from 'react-i18next'
import { useConversation } from '../../../../context/ConversationContext'
import { useResponsiveBreakpoints } from '../../../../hooks/useResponsiveBreakpoints'
import { usePendingProjectName } from '../../../../hooks/usePendingProjectName'
import styles from './NewChatProjectHint.module.scss'

/**
 * 📱 In the empty chat a project's plus opened, says where the chat will go:
 * nothing exists until the first message, so the menu can't show it yet.
 */
export default function NewChatProjectHint(): React.ReactElement | null {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const { conversationBlockList } = useConversation()
    const projectName = usePendingProjectName()
    const hasSent = conversationBlockList.some(block => block.status === 'resolved' || block.isLoading)
    if (!isNarrow || !projectName || hasSent) return null
    return (
        <p className={styles.hint} data-testid="new-chat-project-hint">
            {t('conversation.conversationHeader.newChatInProjectHint', { name: projectName })}
        </p>
    )
}
