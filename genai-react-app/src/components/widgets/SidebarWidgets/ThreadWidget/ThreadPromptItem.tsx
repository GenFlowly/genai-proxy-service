import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Tooltip from '../../../common/Tooltip/Tooltip'
import styles from './ThreadPromptItem.module.scss'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import { useConversation } from '../../../../context/ConversationContext'

interface ThreadPromptItemProps {
    conversationBlockId: string
    prompt: string
    collapsed?: boolean
    'data-testid'?: string
}

export default function ThreadPromptItem({ conversationBlockId, prompt, collapsed = false, 'data-testid': testId }: ThreadPromptItemProps) {
    const { t } = useTranslation()
    const { activeViewportItem } = useConversation()
    
    const handleClick = () => {
        const element = document.querySelector(`[data-block-id="${conversationBlockId}"]`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    // Truncate prompt to first 10 characters
    const truncatedPrompt = prompt.length > 10 ? `${prompt.substring(0, 10)}...` : prompt

    const isActive = activeViewportItem?.blockId === conversationBlockId && activeViewportItem?.type === 'request'
    const itemRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isActive && itemRef.current) {
            itemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
    }, [isActive])

    if (collapsed) {
        return (
            <Tooltip content={prompt || t('sidebar.threadPromptItem.newPrompt')} fullWidth>
                <button ref={itemRef} className={`${styles.promptItem} ${styles.collapsed} ${isActive ? styles.activeViewport : ''}`} onClick={handleClick} data-testid={testId || "thread-prompt-item-collapsed"}>
                    <span className={styles.icon}>
                        <Icon src={ICONS.PROMPT_ICON} />
                    </span>
                </button>
            </Tooltip>
        )
    }

    return (
        <button ref={itemRef} className={`${styles.promptItem} ${isActive ? styles.activeViewport : ''}`} onClick={handleClick} title={prompt} data-testid={testId || "thread-prompt-item"}>
            <span className={styles.icon}>
                <Icon src={ICONS.PROMPT_ICON} />
            </span>
            <span className={styles.text} data-testid="thread-prompt-item-text">{truncatedPrompt || t('sidebar.threadPromptItem.newPrompt')}</span>
        </button>
    )
}
