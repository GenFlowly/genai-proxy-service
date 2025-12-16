import React from 'react'
import styles from './ThreadResponseItem.module.scss'

interface ThreadResponseItemProps {
    conversationBlockId: string
    responseCount: number
    collapsed?: boolean
}

export default function ThreadResponseItem({ conversationBlockId, responseCount, collapsed = false }: ThreadResponseItemProps) {
    const handleClick = () => {
        // Scroll to the response section, not the conversation block
        const element = document.querySelector(`[data-response-block-id="${conversationBlockId}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    const label = responseCount > 1 ? 'Responses' : 'Response'

    if (collapsed) {
        return (
            <button className={`${styles.responseItem} ${styles.collapsed}`} onClick={handleClick} title={label}>
                <span className={styles.icon}>↳</span>
            </button>
        )
    }

    return (
        <button className={styles.responseItem} onClick={handleClick}>
            <span className={styles.icon}>↳</span>
            <span className={styles.text}>{label}</span>
        </button>
    )
}
