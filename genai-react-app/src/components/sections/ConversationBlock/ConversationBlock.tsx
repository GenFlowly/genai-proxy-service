// ConversationBlock.tsx
import React, { useEffect, useRef } from 'react'
import PromptEditor from '../../widgets/PromptEditorWidget/PromptEditor'
import Response from '../../widgets/ResponseWidget/Response'
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import { useConversation } from '../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'

export default function ConversationBlock({ id }: { id: string }) {
    const { conversations, generateResponses, addConversation } = useConversation()
    const block = conversations.find(b => b.id === id)
    const responseRef = useRef<HTMLDivElement | null>(null)

    // 🧷 Scroll to response when generated
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

    return (
        <>
            <PromptEditor id={id} />
            <MultiPurposeButton
                onClick={() => generateResponses(id)}
                label={block.isLoading ? 'Generating...' : 'Send to API'}
                disabled={block.isLoading}
            />
            <div ref={responseRef}>
                <Response responses={block.responses} />
            </div>

            {block.responses.length > 0 && (
                <div className={styles.followUpButtonWrapper}>
                    <button className={styles.followUpButton} onClick={() => {
                        addConversation()
                        setTimeout(() => {
                            const last = document.querySelector(
                                `.${styles.conversationBlock}:last-child`
                            )
                            last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }, 300)
                    }}>
                        ➕ Follow up
                    </button>
                </div>
            )}
        </>
    )
}
