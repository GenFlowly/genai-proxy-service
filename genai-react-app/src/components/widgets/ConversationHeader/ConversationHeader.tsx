import React, { useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import PillButton from '../../common/PillButton/PillButton'
import ShareModal, { VisibilityMode } from '../../common/ShareModal/ShareModal'
import { useConversation } from '../../../context/ConversationContext'
import { useToast } from '../../../context/ToastContext'
import {
    shareConversation,
    unshareConversation,
    getConversationSharedUsers,
} from '../../../services/conversationService'
import { SearchUserResponse } from '../../../models/user.models'
import styles from './ConversationHeader.module.scss'

export default function ConversationHeader(): React.ReactElement | null {
    const { conversationId, conversationTitle, conversationRole } = useConversation()
    const { getAccessTokenSilently } = useAuth0()
    const { showToast } = useToast()
    const [isShareModalOpen, setShareModalOpen] = useState(false)

    if (!conversationId) return null

    const canShare = conversationRole === 'OWNER' || conversationRole === 'EDIT'

    const handleShareSave = async (
        _mode: VisibilityMode,
        users: SearchUserResponse[],
        removedUsers: SearchUserResponse[]
    ) => {
        try {
            const token = await getAccessTokenSilently()
            for (const user of users) {
                await shareConversation(token, conversationId, user.customerId, (user.role as 'VIEW' | 'EDIT') || 'VIEW')
            }
            for (const user of removedUsers) {
                await unshareConversation(token, conversationId, user.customerId)
            }
            showToast('Share settings updated')
        } catch (err) {
            console.error('Failed to update conversation share', err)
            showToast('Failed to update share settings')
        }
    }

    return (
        <div className={styles.header}>
            <div className={styles.title} title={conversationTitle ?? undefined}>
                {conversationTitle ?? 'Untitled conversation'}
            </div>
            <div className={styles.actions}>
                {canShare && (
                    <PillButton
                        label="Share"
                        variant="secondary"
                        onClick={() => setShareModalOpen(true)}
                        data-testid="conversation-share-button"
                    />
                )}
            </div>

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
        </div>
    )
}
