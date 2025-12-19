import React, { useMemo } from 'react'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './Response.module.scss'
import { AIVendor } from '../../../constants/vendors'
import { useLayout } from '../../../context/LayoutContext'
import { useConversation } from '../../../context/ConversationContext'
import TextContainer from '../../common/TextContainer/TextContainer'
import { Message } from "../../../models/conversation.models";

interface ResponseProps {
    blockId: string
    responseMessages: Message[]
    onFollowUp?: (selectedMessageId: string) => void
}

export default function Response({ blockId, responseMessages, onFollowUp }: ResponseProps) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock } = useConversation()

    const selectedResponseId = getSelectedResponseForBlock(blockId)
    console.log("selectedResponseId: ", selectedResponseId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    // Direct usage of props to avoid memoization issues
    const responseList = responseMessages

    if (!responseMessages || responseMessages.length === 0) return null

    const handleFollowUp = (messageId: string) => {
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
                                    <button
                                        className={`${styles.followUpButton} ${isSelected ? styles.selectedButton : ''}`}
                                        onClick={() => handleFollowUp(messageId)}
                                        disabled={isSelected}
                                    >
                                        {isSelected ? (
                                            '✓ Selected'
                                        ) : (
                                            <>
                                                <span>Follow up</span>
                                                <Icon src={ICONS.SEND} />
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
