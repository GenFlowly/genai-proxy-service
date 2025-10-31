import React, { useEffect, useRef } from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import { useConversation } from '../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'

export default function ConversationBlock({ id }: { id: string }) {
    const { conversationBlockList, generateResponses, addNewConversationBlock } = useConversation()
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

    // ✅ Move follow-up logic into callback
    const handleFollowUp = () => {
        addNewConversationBlock()
        setTimeout(() => {
            const last = document.querySelector(
                `.${styles.conversationBlock}:last-child`
            )
            last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 300)
    }

    return (
        <>
            <PromptEditor id={id} />
            <MultiPurposeButton
                onClick={() => generateResponses(id)}
                label={block.isLoading ? 'Generating...' : 'Send to API'}
                disabled={block.isLoading}
            />

            <div ref={responseRef}>
                <Response
                    responses={block.responses}
                    onFollowUp={handleFollowUp} // ✅ Pass down handler
                />
            </div>
        </>
    )
}
