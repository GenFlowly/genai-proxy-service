import React, { useEffect, useRef } from 'react'
import Response from '../ResponseWidget/Response'
import Request from '../RequestWidget/Request'
import { useConversation } from '../../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'
import { useAuth } from '../../../../context/AuthContext'

export default function ConversationBlock({ id }: { id: string }) {
    const {
        conversationBlockList,
        addNewConversationBlockWithId,
        setSelectedResponseForBlock
    } = useConversation()

    // ✅ Check API key status
    const { aiVendorAPIKeyStatusList } = useAuth()
    const hasAnyValidApiKey = aiVendorAPIKeyStatusList.some(s => s.isAPIKeyValid)

    const conversationBlock = conversationBlockList.find(b => b.conversationBlockId === id)
    const responseRef = useRef<HTMLDivElement | null>(null)
    const hasScrolledRef = useRef(false)

    // Reset scroll ref when loading starts (new generation)
    useEffect(() => {
        if (conversationBlock?.isLoading) {
            hasScrolledRef.current = false
        }
    }, [conversationBlock?.isLoading])

    // Scroll to response when it appears and we haven't scrolled yet (Initial "Jump" to start)
    useEffect(() => {
        if (conversationBlock?.responseMessages?.length && responseRef.current && !hasScrolledRef.current) {
            // Wait a tick for layout
            setTimeout(() => {
                responseRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                })
                hasScrolledRef.current = true
            }, 100)
        }
    }, [conversationBlock?.responseMessages, conversationBlock?.isLoading])

    // Continuous scroll during streaming (Sticky Bottom)
    useEffect(() => {
        if (conversationBlock?.isLoading && responseRef.current && hasScrolledRef.current) {
            // Use 'auto' behavior for stickiness to avoid fighting with smooth animation lag
            // Check if element is roughly in view or if we should force it?
            // User requested "automatically scroll down".
            responseRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'end',
            })
        }
    }, [conversationBlock?.responseMessages, conversationBlock?.isLoading])

    if (!conversationBlock) return null

    // ✅ Follow-up logic: reuse last empty block or create new one
    const handleFollowUp = (selectedMessageId: string) => {
        if (!hasAnyValidApiKey) return

        // Get the last conversation block
        const lastBlock = conversationBlockList[conversationBlockList.length - 1]

        // Check if last block is empty (no responses yet)
        const isLastBlockEmpty = lastBlock.responseMessages.length === 0

        if (isLastBlockEmpty) {
            // Reuse the existing empty block
            setSelectedResponseForBlock(lastBlock.conversationBlockId, selectedMessageId)

            // Scroll to the existing block
            setTimeout(() => {
                const last = document.querySelector(`.conversation-block-item:last-child`)
                last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 100)
        } else {
            // Create a new block only if the last one has responses
            const newBlockId = `conv-${Date.now()}`
            addNewConversationBlockWithId(newBlockId)
            setSelectedResponseForBlock(newBlockId, selectedMessageId)

            // Scroll to new block
            setTimeout(() => {
                const last = document.querySelector(`.conversation-block-item:last-child`)
                last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 300)
        }
    }

    return (
        <div className={`${styles.conversationBlock} conversation-block-item`} data-block-id={id}>
            <Request blockId={id} />

            {conversationBlock.responseMessages.length > 0 && (
                <div ref={responseRef} style={{ width: '100%' }}>
                    <Response
                        blockId={id}
                        responseMessages={conversationBlock.responseMessages}
                        onFollowUp={handleFollowUp}
                        disabled={!hasAnyValidApiKey}
                    />
                </div>
            )}
        </div>
    )
}
