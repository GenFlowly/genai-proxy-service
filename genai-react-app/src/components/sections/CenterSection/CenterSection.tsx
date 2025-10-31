// CenterSection.tsx
import React from 'react'
import { useConversation } from '../../../context/ConversationContext'
import ConversationBlock from '../ConversationBlock/ConversationBlock'
import styles from './CenterSection.module.scss'

export default function CenterSection() {
    const { conversationBlockList } = useConversation()

    return (
        <div className={styles.centerSection}>
            <div className={styles.contentWrapper}>
                {conversationBlockList.map(block => (
                    <ConversationBlock key={block.id} id={block.id} />
                ))}
            </div>
        </div>
    )
}
