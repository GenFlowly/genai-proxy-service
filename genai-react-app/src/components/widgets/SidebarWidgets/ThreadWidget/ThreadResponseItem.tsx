import React, { useEffect, useRef } from 'react'
import styles from './ThreadResponseItem.module.scss'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import { useConversation } from '../../../../context/ConversationContext'

interface ThreadResponseItemProps {
    conversationBlockId: string
    responseCount: number
    collapsed?: boolean
    'data-testid'?: string
}

export default function ThreadResponseItem({ conversationBlockId, responseCount, collapsed = false, 'data-testid': testId }: ThreadResponseItemProps) {
    const { activeViewportItem } = useConversation()

    const handleClick = () => {
        // Scroll to the response section, not the conversation block
        const element = document.querySelector(`[data-response-block-id="${conversationBlockId}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // Show 'No Responses' for 0, 'Response' for 1, 'Responses' for > 1
    const label = responseCount === 0 ? 'No Responses' : responseCount === 1 ? 'Response' : 'Responses'

    const isActive = activeViewportItem?.blockId === conversationBlockId && activeViewportItem?.type === 'response'
    const itemRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isActive && itemRef.current) {
            itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
    }, [isActive])

    if (collapsed) {
        return (
            <button ref={itemRef} className={`${styles.responseItem} ${styles.collapsed} ${isActive ? styles.activeViewport : ''}`} onClick={handleClick} title={label} data-testid={testId || "thread-response-item-collapsed"}>
                <span className={styles.icon}>
                    <Icon src={ICONS.RESPONSE_ICON} />
                </span>
            </button>
        )
    }

    return (
        <button ref={itemRef} className={`${styles.responseItem} ${isActive ? styles.activeViewport : ''}`} onClick={handleClick} data-testid={testId || "thread-response-item"}>
            <span className={styles.icon}>
                <Icon src={ICONS.RESPONSE_ICON} />
            </span>
            <span className={styles.text} data-testid="thread-response-item-text">{label}</span>
        </button>
    )
}
