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
import ToggleGroupButton, { ToggleOption } from '../../../common/ToggleGroupButton/ToggleGroupButton'
import { useState, useMemo, useEffect } from 'react'

interface ResponseProps {
    blockId: string
    responseMessages: Message[]
    onFollowUp?: (selectedMessageId: string) => void
    disabled?: boolean
}

export default function Response({ blockId, responseMessages, onFollowUp, disabled = false, 'data-testid': testId }: ResponseProps & { 'data-testid'?: string }) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock } = useConversation()

    const selectedResponseId = getSelectedResponseForBlock(blockId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    // Filter out empty messages first
    // Filter out messages that are empty AND not loading
    const visibleMessages = useMemo(() =>
        responseMessages.filter(msg => msg.text.length > 0 || msg.isLoading),
        [responseMessages]
    )

    // Calculate available vendors
    const availableVendors = useMemo(() => {
        const vendors = new Set<string>()
        visibleMessages.forEach(msg => {
            if (msg.aiVendor) vendors.add(msg.aiVendor)
        })
        return Array.from(vendors)
    }, [visibleMessages])

    // State for selected vendors
    // Initialize with all available vendors whenever availableVendors changes drastically, 
    // or keep previous selection if possible? 
    // For simplicity, if the blockId changes or first load, select all.
    // Actually, simple state initialization is enough, but we want to sync with incoming streaming data if new vendor appears?
    // Let's rely on simple state, initializing with all available.
    // If a new vendor appears mid-stream, we might want to auto-select it? 
    // For now, let's just initialize state once or update it?
    // Let's use a lazy initializer styled effect or just defaulting.

    const [selectedVendors, setSelectedVendors] = useState<string[]>([])


    // Effect to auto-select new vendors if they appear (e.g. streaming starts) 
    // and if we want them visible by default. 
    // User requirement: "By default all responses should be visible".
    // So if a vendor is not in state, add it? 
    // But if user explicitly unselected it, we shouldn't add it back.
    // Detailed logic: maintain a set of "known" vendors. If new one appears, add to selection.

    // Simplest approach satisfying "default all visible":
    // If selectedVendors is empty (initial), set to all available.
    // But we enforce "at least one selected", so it shouldn't be empty unless no data.

    useEffect(() => {
        // If we have vendors but no selection (initial load), select all.
        if (availableVendors.length > 0 && selectedVendors.length === 0) {
            setSelectedVendors(availableVendors)
        } else {


            const newVendors = availableVendors.filter(v => !selectedVendors.includes(v))
            if (newVendors.length > 0) {

            }
        }
    }, [availableVendors, selectedVendors])

    // Mapped options for ToggleGroup
    const toggleOptions: ToggleOption[] = useMemo(() => {
        return availableVendors.map(vendor => ({
            id: vendor,
            label: vendor === AIVendor.OPENAI ? 'OpenAI' :
                vendor === AIVendor.CLAUDE ? 'Claude' :
                    vendor === AIVendor.GEMINI ? 'Gemini' : vendor,
            icon: vendor === AIVendor.OPENAI ? ICONS.OPENAI :
                vendor === AIVendor.CLAUDE ? ICONS.CLAUDE :
                    vendor === AIVendor.GEMINI ? ICONS.GEMINI : undefined
        }))
    }, [availableVendors])

    // Filter list
    const filteredResponseList = visibleMessages.filter(msg =>
        msg.aiVendor && selectedVendors.includes(msg.aiVendor)
    )

    if (!visibleMessages || visibleMessages.length === 0) return null

    const handleFollowUp = (messageId: string) => {
        if (disabled) return
        setSelectedResponseForBlock(blockId, messageId)
        onFollowUp?.(messageId)
    }

    return (
        <div
            className={styles.container}
            data-response-block-id={blockId}
            data-testid={testId}
        >
            {/* Toggle Group Header - Placed above the scrolling container */}
            {availableVendors.length > 1 && (
                <div className={styles.toggleWrapper} style={{ marginTop: '1rem', marginBottom: '0.5rem', width: '100%', display: 'flex', justifyContent: 'center' }}>
                    <ToggleGroupButton
                        options={toggleOptions}
                        selectedValues={selectedVendors}
                        onChange={setSelectedVendors}
                        allowEmpty={false}
                    />
                </div>
            )}

            <div
                className={`${styles.inner} ${sidebarsHidden ? styles.sideBySide : ''}`}
            >

                {filteredResponseList.map(({ aiVendor, text, messageId, isLoading, inputTokens, outputTokens }) => {
                    const isSelected = selectedResponseId === messageId

                    let HeaderComponent: React.ReactNode = null
                    if (aiVendor) {
                        if (aiVendor === AIVendor.OPENAI) HeaderComponent = <OpenAIBrandName as="span" />
                        else if (aiVendor === AIVendor.CLAUDE) HeaderComponent = <ClaudeBrandName as="span" />
                        else if (aiVendor === AIVendor.GEMINI) HeaderComponent = <GeminiBrandName as="span" />
                        else HeaderComponent = <h2>{aiVendor}</h2>
                    }

                    return (
                        <TextContainer
                            key={messageId}
                            title={HeaderComponent}
                            content={text}
                            className={`${styles.responseWrapper} ${isSelected ? styles.selected : ''}`}
                            isLoading={isLoading && text.trim().length === 0}
                            loadingContent={
                                <div
                                    style={{ padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: 0.6, fontStyle: 'italic' }}
                                    data-testid="response-message-loading"
                                >
                                    <Icon src={ICONS.THINK} size={20} />
                                    <span>Thinking...</span>
                                </div>
                            }
                            data-testid="response-message"
                            aria-label={`Response from ${aiVendor}`}
                        >
                            {onFollowUp && !isLoading && (
                                <div className={styles.followUpButtonWrapper}>
                                    {(inputTokens != null || outputTokens != null) && (
                                        <div className={styles.tokenBadge}>
                                            {inputTokens != null && (
                                                <span className={styles.tokenItem} title="Input tokens">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                                        <path d="M12 2L2 7l10 5 10-5-10-5z" />
                                                        <path d="M2 17l10 5 10-5" />
                                                        <path d="M2 12l10 5 10-5" />
                                                    </svg>
                                                    {inputTokens.toLocaleString()}
                                                </span>
                                            )}
                                            {outputTokens != null && (
                                                <span className={styles.tokenItem} title="Output tokens">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                                                    </svg>
                                                    {outputTokens.toLocaleString()}
                                                </span>
                                            )}
                                        </div>
                                    )}
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
                            )}
                        </TextContainer>
                    )
                })}
            </div>
        </div>
    )
}
