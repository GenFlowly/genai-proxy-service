import React from 'react'
import Tooltip from '../../../common/Tooltip/Tooltip'
import styles from './ThreadPromptItem.module.scss'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'

interface ThreadPromptItemProps {
    conversationBlockId: string
    prompt: string
    collapsed?: boolean
    'data-testid'?: string
}

export default function ThreadPromptItem({ conversationBlockId, prompt, collapsed = false, 'data-testid': testId }: ThreadPromptItemProps) {
    const handleClick = () => {
        const element = document.querySelector(`[data-block-id="${conversationBlockId}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    // Truncate prompt to first 10 characters
    const truncatedPrompt = prompt.length > 10 ? `${prompt.substring(0, 10)}...` : prompt

    if (collapsed) {
        return (
            <Tooltip content={prompt || 'New prompt'}>
                <button className={`${styles.promptItem} ${styles.collapsed}`} onClick={handleClick} data-testid={testId || "thread-prompt-item-collapsed"}>
                    <span className={styles.icon}>
                        <Icon src={ICONS.PROMPT_ICON} />
                    </span>
                </button>
            </Tooltip>
        )
    }

    return (
        <button className={styles.promptItem} onClick={handleClick} title={prompt} data-testid={testId || "thread-prompt-item"}>
            <span className={styles.icon}>
                <Icon src={ICONS.PROMPT_ICON} />
            </span>
            <span className={styles.text} data-testid="thread-prompt-item-text">{truncatedPrompt || 'New prompt'}</span>
        </button>
    )
}
