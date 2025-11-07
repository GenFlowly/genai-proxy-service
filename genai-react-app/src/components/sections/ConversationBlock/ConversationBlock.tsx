import React, {useEffect, useRef} from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import MultiPurposeButton
    from '../../common/MultiPurposeButton/MultiPurposeButton'
import {useConversation} from '../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'

export default function ConversationBlock({id}: { id: string }) {
    const {
        conversationBlockList,
        generateResponses,
        addNewConversationBlock,
        addNewConversationBlockWithId,
        setSelectedResponseForBlock
    } = useConversation()

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === id)
    const responseRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (conversationBlock?.responseMessages?.length && responseRef.current) {
            if ("scrollIntoView" in responseRef.current) {
                responseRef.current.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                })
            }
        }
    }, [conversationBlock?.responseMessages])

    if (!conversationBlock) return null

    // ✅ Follow-up logic restored
    const handleFollowUp = (selectedMessageId: string) => {
        // Create a new block and inherit the selected response ID
        const newBlockId = `conv-${Date.now()}`
        addNewConversationBlockWithId(newBlockId)

        // Persist the follow-up link
        setSelectedResponseForBlock(newBlockId, selectedMessageId)

        // Optional: scroll to new block
        setTimeout(() => {
            const last = document.querySelector(`.${styles.conversationBlock}:last-child`)
            last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 300)
    }

    return (
        <div className={styles.conversationBlock}>
            <PromptEditor id={id}/>

            <MultiPurposeButton
                onClick={() => generateResponses(id)}
                label={conversationBlock.isLoading ? 'Generating...' : 'Send to API'}
                disabled={conversationBlock.isLoading}
            />

            {conversationBlock.responseMessages.length > 0 && (
                <div ref={responseRef}>
                    <Response
                        blockId={id}
                        responseMessages={conversationBlock.responseMessages}
                        onFollowUp={handleFollowUp}
                    />
                </div>
            )}
        </div>
    )
}
