import React, { useEffect, useRef } from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import { useConversation } from '../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'

export default function ConversationBlock({ id }: { id: string }) {
    const {
        conversationBlockList,
        generateResponses,
        addNewConversationBlock,
        getSelectedResponseForBlock,
    } = useConversation()

    const block = conversationBlockList.find(b => b.id === id)
    const responseRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (block?.responses?.length && responseRef.current) {
            if ("scrollIntoView" in responseRef.current) {
                responseRef.current.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                })
            }
        }
    }, [block?.responses])

    if (!block) return null

    // ✅ Follow-up logic restored
    const handleFollowUp = () => {
        const selectedResponse = getSelectedResponseForBlock(id)

        // It’s okay if no specific response selected — still add a new block
        addNewConversationBlock()

        // Optional: scroll smoothly to new block
        setTimeout(() => {
            const last = document.querySelector(`.${styles.conversationBlock}:last-child`)
            last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 300)
    }

    return (
        <div className={styles.conversationBlock}>
            <PromptEditor id={id} />

            <MultiPurposeButton
                onClick={() => generateResponses(id)}
                label={block.isLoading ? 'Generating...' : 'Send to API'}
                disabled={block.isLoading}
            />

            {block.responses.length > 0 && (
                <div ref={responseRef}>
                    <Response
                        blockId={id}
                        responses={block.responses}
                        onFollowUp={handleFollowUp}
                    />
                </div>
            )}
        </div>
    )
}
