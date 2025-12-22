import React from 'react'
import { useConversation } from '../../../context/ConversationContext'
import PillButton from '../../common/PillButton/PillButton'
import { ICONS } from '../../../constants/icons'
import styles from './NewChatWidget.module.scss'

export default function NewChatWidget(): React.ReactElement {
    const { resetConversation } = useConversation()

    return (
        <div className={styles.container}>
            <PillButton
                label="New Chat"
                onClick={resetConversation}
                icon={ICONS.PLUS}
                className={styles.fullWidthButton}
            />
        </div>
    )
}
