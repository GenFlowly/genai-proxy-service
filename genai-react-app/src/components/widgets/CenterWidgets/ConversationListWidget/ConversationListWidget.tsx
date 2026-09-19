import React, { useEffect } from 'react'
import { useConversation, useConversationUI } from '../../../../context/ConversationContext'
import ConversationBlock from '../../../widgets/ConversationWidget/ConversationBlock/ConversationBlock'

export default function ConversationListWidget() {
    const { conversationBlockList } = useConversation()
    const { setActiveViewportItem } = useConversationUI()

    useEffect(() => {
        const root = document.querySelector('[data-testid="center-section"]')
        if (!root) return

        const options = {
            root: root,
            rootMargin: '-10% 0px -70% 0px', // Triggers when element is near the top
            threshold: 0
        }

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const blockId = entry.target.getAttribute('data-block-id')
                    const type = entry.target.getAttribute('data-item-type') as 'request' | 'response'
                    if (blockId && type) {
                        setActiveViewportItem({ blockId, type })
                    }
                }
            })
        }, options)

        // Allow some time for elements to render
        const timeout = setTimeout(() => {
            const elements = document.querySelectorAll('[data-scroll-item="true"]')
            elements.forEach(el => observer.observe(el))
        }, 100)

        return () => {
            clearTimeout(timeout)
            observer.disconnect()
        }
    }, [conversationBlockList, setActiveViewportItem])

    return (
        <React.Fragment>
            {conversationBlockList.map(block => (
                <ConversationBlock key={block.conversationBlockId} id={block.conversationBlockId} />
            ))}
        </React.Fragment>
    )
}
