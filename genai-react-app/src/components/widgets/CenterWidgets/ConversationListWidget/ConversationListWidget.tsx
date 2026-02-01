import React from 'react'
import { useConversation } from '../../../../context/ConversationContext'
import ConversationBlock from '../../../widgets/ConversationWidget/ConversationBlock/ConversationBlock'

export default function ConversationListWidget() {
    const { conversationBlockList } = useConversation()

    return (
        <React.Fragment>
            {conversationBlockList.map(block => (
                <ConversationBlock key={block.conversationBlockId} id={block.conversationBlockId} />
            ))}
        </React.Fragment>
    )
}
