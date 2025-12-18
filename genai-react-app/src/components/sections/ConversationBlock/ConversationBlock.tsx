import React, { useEffect, useRef } from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import MultiPurposeButton
    from '../../common/MultiPurposeButton/MultiPurposeButton'
import { useConversation } from '../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'

export default function ConversationBlock({ id }: { id: string }) {
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

    // ✅ Follow-up logic: reuse last empty block or create new one
    const handleFollowUp = (selectedMessageId: string) => {
        // Get the last conversation block
        const lastBlock = conversationBlockList[conversationBlockList.length - 1]

        // Check if last block is empty (no responses yet)
        const isLastBlockEmpty = lastBlock.responseMessages.length === 0

        if (isLastBlockEmpty) {
            // Reuse the existing empty block
            setSelectedResponseForBlock(lastBlock.conversationBlockId, selectedMessageId)

            // Scroll to the existing block
            setTimeout(() => {
                const last = document.querySelector(`.${styles.conversationBlock}:last-child`)
                last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 100)
        } else {
            // Create a new block only if the last one has responses
            const newBlockId = `conv-${Date.now()}`
            addNewConversationBlockWithId(newBlockId)
            setSelectedResponseForBlock(newBlockId, selectedMessageId)

            // Scroll to new block
            setTimeout(() => {
                const last = document.querySelector(`.${styles.conversationBlock}:last-child`)
                last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 300)
        }
    }

    return (
        <div className={styles.conversationBlock} data-block-id={id}>
            <PromptEditor id={id} />

            {conversationBlock.responseMessages.length === 0 && (
                <MultiPurposeButton
                    onClick={() => generateResponses(id)}
                    label={conversationBlock.isLoading ? 'Generating...' : 'Send to API'}
                    disabled={conversationBlock.isLoading}
                />
            )}

            {conversationBlock.responseMessages.length > 0 && (
                <div ref={responseRef} style={{ width: '100%' }}>
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
