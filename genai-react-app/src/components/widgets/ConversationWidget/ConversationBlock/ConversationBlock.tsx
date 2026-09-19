import React, { useCallback, useEffect, useRef } from 'react'
import Response from '../ResponseWidget/Response'
import Request from '../RequestWidget/Request'
import { useConversation } from '../../../../context/ConversationContext'
import styles from './ConversationBlock.module.scss'
import { useAuth } from '../../../../context/AuthContext'

// Memoized: the block list parent re-renders on unrelated layout/context
// changes; a block only needs to re-render when its own context reads change
function ConversationBlock({ id, 'data-testid': testId }: { id: string, 'data-testid'?: string }) {
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
    const isAutoScrollPausedRef = useRef(false)

    // Reset scroll ref when loading starts (new generation)
    useEffect(() => {
        if (conversationBlock?.isLoading) {
            hasScrolledRef.current = false
            isAutoScrollPausedRef.current = false
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
        if (conversationBlock?.isLoading && responseRef.current && hasScrolledRef.current && !isAutoScrollPausedRef.current) {
            // Use 'auto' behavior for stickiness to avoid fighting with smooth animation lag
            responseRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'end',
            })
        }
    }, [conversationBlock?.responseMessages, conversationBlock?.isLoading])

    // Detect user scroll to pause/resume auto-scroll
    useEffect(() => {
        if (!conversationBlock?.isLoading || !responseRef.current) return;

        const scrollElement = responseRef.current.closest('[data-testid*="center-section"]');
        const scrollContainer = scrollElement || window;

        const handleWheel = (e: WheelEvent) => {
            if (e.deltaY < 0) {
                // User scrolled up
                isAutoScrollPausedRef.current = true;
            }
        };

        const handleTouchStart = () => {
            // Pause on touch interactions to allow manual drag
            isAutoScrollPausedRef.current = true;
        };

        const handleScroll = () => {
            // Resume if user scrolls to the bottom of the container naturally
            const container = scrollElement ? (scrollElement as HTMLElement) : document.documentElement;
            const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;

            if (isNearBottom) {
                isAutoScrollPausedRef.current = false;
            }
        };

        scrollContainer.addEventListener('wheel', handleWheel as EventListener, { passive: true });
        scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            scrollContainer.removeEventListener('wheel', handleWheel as EventListener);
            scrollContainer.removeEventListener('touchstart', handleTouchStart);
            scrollContainer.removeEventListener('scroll', handleScroll);
        }
    }, [conversationBlock?.isLoading])

    // ✅ Follow-up logic: reuse last empty block or create new one.
    // useCallback so Response's memo isn't broken by a fresh handler each render
    const handleFollowUp = useCallback((selectedMessageId: string) => {
        if (!hasAnyValidApiKey) return

        // 📱 The follow-up editor should come up ready to type, keyboard open.
        // iOS only shows the keyboard for focus() calls made inside the tap
        // gesture — the editor may not even exist yet, so focus a throwaway
        // input NOW and hand focus over once the editor is in the DOM.
        const tempInput = document.createElement('input')
        tempInput.type = 'text'
        tempInput.style.position = 'fixed'
        tempInput.style.opacity = '0'
        tempInput.style.height = '0'
        tempInput.style.fontSize = '16px' // prevent iOS zoom-on-focus
        document.body.appendChild(tempInput)
        tempInput.focus({ preventScroll: true })

        const focusEditor = () => {
            const editorInput = document.querySelector<HTMLElement>(
                '.conversation-block-item:last-child .cm-content, ' +
                '.conversation-block-item:last-child textarea'
            )
            editorInput?.focus({ preventScroll: true })
            tempInput.remove()
        }

        // Get the last conversation block
        const lastBlock = conversationBlockList[conversationBlockList.length - 1]

        // Check if last block is a truly empty draft (waiting for input). A block
        // that is mid-generation is also still 'draft' — it must NOT be reused,
        // otherwise following up from an already-finished response while another
        // vendor streams becomes a silent no-op
        const isLastBlockEmpty = lastBlock.status === 'draft'
            && lastBlock.responseMessages.length === 0
            && !lastBlock.isLoading

        if (isLastBlockEmpty) {
            // Reuse the existing empty block
            setSelectedResponseForBlock(lastBlock.conversationBlockId, selectedMessageId)

            // Scroll to the existing block
            setTimeout(() => {
                const last = document.querySelector(`.conversation-block-item:last-child`)
                last?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                focusEditor()
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
                focusEditor()
            }, 300)
        }
    }, [hasAnyValidApiKey, conversationBlockList, setSelectedResponseForBlock, addNewConversationBlockWithId])

    if (!conversationBlock) return null

    const isLastResponseBlock = [...conversationBlockList].reverse().find(b => b.responseMessages.length > 0)?.conversationBlockId === id

    return (
        <div className={`${styles.conversationBlock} conversation-block-item`} data-block-id={id} data-testid={testId}>
            <div data-scroll-item="true" data-block-id={id} data-item-type="request" style={{ width: '100%' }}>
                <Request blockId={id} />
            </div>

            {((conversationBlock.status === 'resolved') || (conversationBlock.responseMessages.length > 0)) && (
                <div ref={responseRef} style={{ width: '100%' }} data-scroll-item="true" data-block-id={id} data-item-type="response">
                    <Response
                        blockId={id}
                        responseMessages={conversationBlock.responseMessages}
                        onFollowUp={handleFollowUp}
                        disabled={!hasAnyValidApiKey}
                        isLastResponseBlock={isLastResponseBlock}
                    />
                </div>
            )}
        </div>
    )
}

export default React.memo(ConversationBlock)
