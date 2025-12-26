// CenterSection.tsx
import React from 'react'
import { useConversation } from '../../../context/ConversationContext'
import ConversationBlock from '../../widgets/ConversationWidget/ConversationBlock/ConversationBlock';
// @ts-ignore
import InstructionWidget from '../../widgets/InstructionWidget/InstructionWidget'
import styles from './CenterSection.module.scss'

export default function CenterSection() {
    const { conversationBlockList } = useConversation()

    return (
        <div className={styles.centerSection}>
            <div className={styles.contentWrapper}>
                <InstructionWidget />
                {conversationBlockList.map(block => (
                    <ConversationBlock key={block.conversationBlockId} id={block.conversationBlockId} />
                ))}
            </div>
        </div>
    )
}
