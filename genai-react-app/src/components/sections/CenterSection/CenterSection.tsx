// CenterSection.tsx
import React from 'react'
import { useConversation } from '../../../context/ConversationContext'
import ConversationBlock from '../../widgets/ConversationWidget/ConversationBlock/ConversationBlock';
// @ts-ignore
import InstructionWidget from '../../widgets/InstructionWidget/InstructionWidget'
import styles from './CenterSection.module.scss'

export default function CenterSection({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { conversationBlockList } = useConversation()

    return (
        <div className={styles.centerSection} data-testid={testId || "center-section"}>
            <div className={styles.contentWrapper} data-testid="center-section-content">
                <div id="instruction-widget-scroll-anchor" style={{ width: '100%' }}>
                    <InstructionWidget />
                </div>
                {conversationBlockList.map(block => (
                    <ConversationBlock key={block.conversationBlockId} id={block.conversationBlockId} />
                ))}
            </div>
        </div>
    )
}
