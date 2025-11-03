import React, { useMemo } from 'react'
import styles from './Response.module.scss'
import { AIVendor } from '../../../constants/vendors'
import { useLayout } from '../../../context/LayoutContext'
import { useConversation } from '../../../context/ConversationContext'
import TextContainer from '../../common/TextContainer/TextContainer'

interface ResponseProps {
    blockId: string
    responses: { vendor: AIVendor; text: string }[]
    onFollowUp?: () => void
}

export default function Response({ blockId, responses, onFollowUp }: ResponseProps) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock } = useConversation()

    // ✅ Always declare hooks before conditionals
    const selectedResponseId = getSelectedResponseForBlock(blockId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    // ✅ Memoize list to avoid re-render churn
    const responseList = useMemo(() => {
        return responses.map((resp, index) => ({
            ...resp,
            id: `${blockId}-resp-${index}`,
        }))
    }, [responses, blockId])

    // ✅ Early return AFTER hooks are declared
    if (!responses || responses.length === 0) return null

    const handleFollowUp = (responseId: string) => {
        setSelectedResponseForBlock(blockId, responseId)
        onFollowUp?.()
    }

    return (
        <div className={styles.container}>
            <div
                className={`${styles.inner} ${
                    sidebarsHidden ? styles.sideBySide : ''
                }`}
            >
                {responseList.map(({ vendor, text, id }) => {
                    const isSelected = selectedResponseId === id

                    return (
                        <div
                            key={id}
                            className={`${styles.responseWrapper} ${
                                isSelected ? styles.selected : ''
                            }`}
                        >
                            <TextContainer
                                title={vendor}
                                content={text}
                                className={isSelected ? styles.selected : ''}
                            />

                            {onFollowUp && (
                                <div className={styles.followUpButtonWrapper}>
                                    <button
                                        className={styles.followUpButton}
                                        onClick={() => handleFollowUp(id)}
                                        disabled={isSelected}
                                    >
                                        ➕ Follow up
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
