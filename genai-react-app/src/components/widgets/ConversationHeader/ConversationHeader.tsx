import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth0 } from '@auth0/auth0-react'
import ShareModal, { VisibilityMode } from '../../common/ShareModal/ShareModal'
import PillButton from '../../common/PillButton/PillButton'
import PageHeader, { pageHeaderStyles } from '../../common/PageHeader/PageHeader'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
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
    const { entitlements } = useAuth()
    const { showToast } = useToast()
    const [isShareModalOpen, setShareModalOpen] = useState(false)

    const isNewChat = !conversationId
    const canShare = conversationRole === 'OWNER' || conversationRole === 'EDIT'
    const showShare = entitlements.canShare && (isNewChat || canShare)
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

    return (
        <PageHeader
            title={displayTitle}
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
                            onClick={() => !isNewChat && setShareModalOpen(true)}
                            data-testid="conversation-share-button"
                            disabled={isNewChat}
                        />
                    )}
                </>
            )}
        >
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
        </PageHeader>
    )
}
