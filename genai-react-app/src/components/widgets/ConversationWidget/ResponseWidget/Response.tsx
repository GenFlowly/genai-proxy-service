import React from 'react'
import { ICONS } from '../../../../constants/icons'
import styles from './Response.module.scss'
import { useLayout } from '../../../../context/LayoutContext'
import { useConversation } from '../../../../context/ConversationContext'
import TextContainer from '../../../common/TextContainer/TextContainer'
import { Icon } from '../../../common/Icon/Icon'
import { Message } from "../../../../models/conversation.models";
import MultiPurposeButton from '../../../common/MultiPurposeButton/MultiPurposeButton'
import Tooltip from '../../../common/Tooltip/Tooltip'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../../common/BrandName/BrandName'
import { AIVendor } from '../../../../constants/vendors'
import { useMemo } from 'react'

interface ResponseProps {
    blockId: string
    responseMessages: Message[]
    onFollowUp?: (selectedMessageId: string) => void
    disabled?: boolean
    isLastResponseBlock?: boolean
}

export default function Response({ blockId, responseMessages, onFollowUp, disabled = false, isLastResponseBlock = true, 'data-testid': testId }: ResponseProps & { 'data-testid'?: string }) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock, generateResponsesStream, getVendorSelectionForBlock } = useConversation()

    const selectedResponseId = getSelectedResponseForBlock(blockId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    const visibleMessages = useMemo(() =>
        responseMessages.filter(msg => msg.text.length > 0 || msg.isLoading),
        [responseMessages]
    )

    const availableVendors = useMemo(() => {
        const vendors = new Set<string>()
        visibleMessages.forEach(msg => {
            if (msg.aiVendor) vendors.add(msg.aiVendor)
        })
        return Array.from(vendors)
    }, [visibleMessages])

    const selectedVendors = getVendorSelectionForBlock(blockId)
    const effectiveSelectedVendors = selectedVendors.length > 0 ? selectedVendors : availableVendors
    const filteredResponseList = useMemo(() => {
        const vendorMap = new Map<string, Message>()
        for (const msg of visibleMessages) {
            if (msg.aiVendor && effectiveSelectedVendors.includes(msg.aiVendor)) {
                vendorMap.set(msg.aiVendor, msg) // This will overwrite older messages, keeping the latest one
            }
        }
        return Array.from(vendorMap.values())
    }, [visibleMessages, effectiveSelectedVendors])

    if (!visibleMessages || visibleMessages.length === 0) {
        return (
            <div
                className={styles.container}
                data-response-block-id={blockId}
                data-testid={testId || "empty-response-block"}
            >
                <div style={{ textAlign: 'left', padding: '1rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    No responses were generated
                </div>
            </div>
        )
    }

    const handleFollowUp = (messageId: string) => {
        if (disabled) return
        setSelectedResponseForBlock(blockId, messageId)
        onFollowUp?.(messageId)
    }

    const handleRegenerate = async (vendor: AIVendor) => {
        if (disabled) return
        await generateResponsesStream(blockId, undefined, undefined, vendor)
    }

    return (
        <div
            className={styles.container}
            data-response-block-id={blockId}
            data-testid={testId}
        >
            <div className={`${styles.inner} ${sidebarsHidden ? styles.sideBySide : ''}`}>
                {filteredResponseList.map(({ aiVendor, text, messageId, isLoading, inputTokens, outputTokens, totalTokens, tokensReadFromCache }) => {
                    const isSelected = selectedResponseId === messageId

                    let HeaderComponent: React.ReactNode = null
                    if (aiVendor) {
                        if (aiVendor === AIVendor.OPENAI) HeaderComponent = <OpenAIBrandName as="span" />
                        else if (aiVendor === AIVendor.CLAUDE) HeaderComponent = <ClaudeBrandName as="span" />
                        else if (aiVendor === AIVendor.GEMINI) HeaderComponent = <GeminiBrandName as="span" />
                        else HeaderComponent = <h2>{aiVendor}</h2>
                    }

                    return (
                        <div key={messageId} className={`${styles.responseWrapper} ${isSelected ? styles.selected : ''}`}>
                            <TextContainer
                                title={HeaderComponent}
                                content={text}
                                isLoading={isLoading && text.trim().length === 0}
                                loadingContent={null}
                                data-testid="response-message"
                                aria-label={`Response from ${aiVendor}`}
                            >
                                {!isLoading && (inputTokens != null || outputTokens != null || totalTokens != null || tokensReadFromCache != null) && (
                                    <div className={styles.tokenBadge}>
                                        {inputTokens != null && (
                                            <Tooltip content="Total Input Tokens">
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.INPUT_TOKENS} size={12} />
                                                    {inputTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {outputTokens != null && (
                                            <Tooltip content="Total Output Tokens">
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.OUTPUT_TOKENS} size={12} />
                                                    {outputTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {tokensReadFromCache != null && (
                                            <Tooltip content="Tokens read from cache">
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.CACHE_TOKENS} size={12} />
                                                    {tokensReadFromCache.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {totalTokens != null && (
                                            <Tooltip content="Total Tokens">
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.TOTAL_TOKENS} size={12} />
                                                    {totalTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                )}
                                {onFollowUp && !isLoading && isLastResponseBlock && (
                                    <div className={styles.followUpButtonWrapper}>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            <Tooltip content={disabled ? "No API keys set" : ""}>
                                                <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                                    <MultiPurposeButton
                                                        label="Regenerate"
                                                        onClick={() => handleRegenerate(aiVendor as AIVendor)}
                                                        disabled={disabled}
                                                        icon={ICONS.REFRESH_ICON}
                                                        data-testid="regenerate-button"
                                                    />
                                                </div>
                                            </Tooltip>

                                            <Tooltip content={disabled ? "No API keys set" : ""}>
                                                <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                                    <MultiPurposeButton
                                                        label={isSelected ? 'Selected' : 'Follow up'}
                                                        onClick={() => handleFollowUp(messageId)}
                                                        disabled={isSelected || disabled}
                                                        icon={isSelected ? undefined : ICONS.SEND}
                                                        data-testid="follow-up-button"
                                                    />
                                                </div>
                                            </Tooltip>
                                        </div>
                                    </div>
                                )}
                            </TextContainer>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
