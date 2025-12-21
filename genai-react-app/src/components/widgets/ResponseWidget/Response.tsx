import React from 'react'
import { ICONS } from '../../../constants/icons'
import styles from './Response.module.scss'
import { useLayout } from '../../../context/LayoutContext'
import { useConversation } from '../../../context/ConversationContext'
import TextContainer from '../../common/TextContainer/TextContainer'
import { Message } from "../../../models/conversation.models";
import MultiPurposeButton from '../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../common/Tooltip/Tooltip'

interface ResponseProps {
    blockId: string
    responseMessages: Message[]
    onFollowUp?: (selectedMessageId: string) => void
    disabled?: boolean
}

export default function Response({ blockId, responseMessages, onFollowUp, disabled = false }: ResponseProps) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock } = useConversation()

    const selectedResponseId = getSelectedResponseForBlock(blockId)
    console.log("selectedResponseId: ", selectedResponseId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    // Direct usage of props to avoid memoization issues
    const responseList = responseMessages

    if (!responseMessages || responseMessages.length === 0) return null

    const handleFollowUp = (messageId: string) => {
        if (disabled) return
        setSelectedResponseForBlock(blockId, messageId)
        onFollowUp?.(messageId)
    }

    return (
        <div
            className={styles.container}
            data-response-block-id={blockId}
        >
            <div
                className={`${styles.inner} ${sidebarsHidden ? styles.sideBySide : ''}`}
            >
                {responseList.map(({ aiVendor, text, messageId }) => {
                    const isSelected = selectedResponseId === messageId


                    return (
                        <div
                            key={messageId}
                            className={`${styles.responseWrapper} ${isSelected ? styles.selected : ''}`}
                        >
                            <TextContainer
                                title={aiVendor}
                                content={text}
                                className={isSelected ? styles.selected : ''}
                            />

                            {onFollowUp && (
                                <div className={styles.followUpButtonWrapper}>
                                    <Tooltip content={disabled ? "No API keys set" : ""}>
                                        <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                            <MultiPurposeButton
                                                label={isSelected ? 'Selected' : 'Follow up'}
                                                onClick={() => handleFollowUp(messageId)}
                                                disabled={isSelected || disabled}
                                                icon={isSelected ? undefined : ICONS.SEND}
                                            />
                                        </div>
                                    </Tooltip>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
