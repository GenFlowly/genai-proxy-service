import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ICONS } from '../../../../constants/icons'
import styles from './Response.module.scss'
import { useLayout } from '../../../../context/LayoutContext'
import { useConversation } from '../../../../context/ConversationContext'
import { TextContainer } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import { Message } from "../../../../models/conversation.models";
import { MultiPurposeButton } from '@genflowly/component-library'
import { Tooltip } from '@genflowly/component-library'
import {
    OpenAIBrandName,
    ClaudeBrandName,
    GeminiBrandName
} from '../../../common/BrandName/BrandName'
import { AIVendor } from '../../../../constants/vendors'
import { useMaxVendors } from '../../../../hooks/useMaxVendors'
import { ToggleOption } from '@genflowly/component-library'
import { RadioButtonGroup } from '@genflowly/component-library'
import { CheckboxButtonGroup } from '@genflowly/component-library'

interface ResponseProps {
    blockId: string
    responseMessages: Message[]
    onFollowUp?: (selectedMessageId: string) => void
    disabled?: boolean
    isLastResponseBlock?: boolean
}

/**
 * Collapsible thinking summary shown inside each response card, between the
 * header and the response text (formerly the separate ResponseThinking widget).
 */
function ThinkingSection({ steps, isThinking, durationMs }: { steps: string[], isThinking: boolean, durationMs?: number | null }) {
    const { t } = useTranslation()
    const [isExpanded, setIsExpanded] = useState(true)

    // Auto-collapse once the answer starts streaming
    useEffect(() => {
        if (!isThinking) setIsExpanded(false)
    }, [isThinking])

    if (steps.length === 0 && !isThinking) return null

    // Once thinking completes, show how long it took (measured by the
    // retrieval server: request receipt → first generated token)
    let label = t('conversation.response.thinking')
    if (!isThinking && durationMs != null) {
        const seconds = Math.max(1, Math.round(durationMs / 1000))
        label = t('conversation.response.thoughtForSeconds', { count: seconds })
    }

    return (
        <div className={styles.thinkingSection} data-testid="thinking-section">
            <button
                className={styles.thinkingToggle}
                onClick={() => setIsExpanded(prev => !prev)}
                aria-expanded={isExpanded}
            >
                {isThinking && <span className={styles.pulse} />}
                <span className={styles.thinkingLabel}>{label}</span>
                <span className={styles.chevron}>{isExpanded ? '▼' : '▶'}</span>
            </button>
            {/* No placeholder when steps haven't arrived yet — the toggle's
                "Thinking" label plus pulse already says it */}
            {isExpanded && steps.length > 0 && (
                <ul className={styles.thinkingSteps}>
                    {steps.map((step, i) => <li key={i}>{step}</li>)}
                </ul>
            )}
        </div>
    )
}

export default function Response({ blockId, responseMessages, onFollowUp, disabled = false, isLastResponseBlock = true, 'data-testid': testId }: ResponseProps & { 'data-testid'?: string }) {
    const { t } = useTranslation()
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock, generateResponsesStream, getVendorSelectionForBlock, setVendorSelectionForBlock, stopGenerating } = useConversation()

    const selectedResponseId = getSelectedResponseForBlock(blockId)
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    const visibleMessages = useMemo(() =>
        responseMessages.filter(msg => msg.text.length > 0 || msg.isLoading || msg.error),
        [responseMessages]
    )

    const availableVendors = useMemo(() => {
        const vendors = new Set<string>()
        visibleMessages.forEach(msg => {
            if (msg.aiVendor) vendors.add(msg.aiVendor)
        })
        return Array.from(vendors)
    }, [visibleMessages])

    // Keep a ref to the latest context selection to avoid stale closure in the effect below
    const selectionRef = useRef<string[]>([])
    selectionRef.current = getVendorSelectionForBlock(blockId)

    // Auto-select any vendor that appears for the first time in this block
    useEffect(() => {
        const newVendors = availableVendors.filter(v => !selectionRef.current.includes(v))
        if (newVendors.length > 0) {
            setVendorSelectionForBlock(blockId, [...selectionRef.current, ...newVendors])
        }
    }, [availableVendors, blockId, setVendorSelectionForBlock])

    const selectedVendors = getVendorSelectionForBlock(blockId)
    const maxVendors = useMaxVendors()

    const toggleOptions: ToggleOption[] = useMemo(() => availableVendors.map(vendor => ({
        id: vendor,
        label: vendor === AIVendor.OPENAI ? 'OpenAI' :
            vendor === AIVendor.CLAUDE ? 'Claude' :
                vendor === AIVendor.GEMINI ? 'Gemini' : vendor
    })), [availableVendors])
    const rawSelectedVendors = selectedVendors.length > 0 ? selectedVendors : availableVendors
    const effectiveSelectedVendors = rawSelectedVendors.slice(0, maxVendors)
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
                    {t('conversation.response.noResponsesGenerated')}
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
            {availableVendors.length > 1 && (
                <div className={styles.toggleWrapper}>
                    {availableVendors.length > maxVendors ? (
                        // More vendors than columns fit on this screen: pick one at a time
                        <RadioButtonGroup
                            options={toggleOptions}
                            selectedValues={effectiveSelectedVendors}
                            onChange={(vendors) => setVendorSelectionForBlock(blockId, vendors)}
                            allowEmpty={false}
                            data-testid="vendor-radio-group"
                        />
                    ) : (
                        // All vendors fit: toggle freely up to the column limit
                        <CheckboxButtonGroup
                            options={toggleOptions}
                            selectedValues={effectiveSelectedVendors}
                            onChange={(vendors) => setVendorSelectionForBlock(blockId, vendors)}
                            allowEmpty={false}
                            maxSelection={maxVendors}
                            data-testid="vendor-checkbox-group"
                        />
                    )}
                </div>
            )}

            <div className={`${styles.inner} ${sidebarsHidden ? styles.sideBySide : ''}`}>
                {filteredResponseList.map(({ aiVendor, model, text, messageId, isLoading, error, thinkingSteps, thinkingDurationMs, inputTokens, outputTokens, totalTokens, tokensReadFromCache }) => {
                    const isSelected = selectedResponseId === messageId
                    const isThinkingPhase = !!isLoading && text.trim().length === 0

                    let HeaderComponent: React.ReactNode = null
                    if (aiVendor) {
                        let brand: React.ReactNode
                        if (aiVendor === AIVendor.OPENAI) brand = <OpenAIBrandName as="span" />
                        else if (aiVendor === AIVendor.CLAUDE) brand = <ClaudeBrandName as="span" />
                        else if (aiVendor === AIVendor.GEMINI) brand = <GeminiBrandName as="span" />
                        else brand = <h2>{aiVendor}</h2>
                        HeaderComponent = (
                            <span className={styles.responseCardTitle}>
                                {brand}
                                {model && (
                                    <span className={styles.modelName} data-testid="response-model-name" title={model}>
                                        {model}
                                    </span>
                                )}
                            </span>
                        )
                    }

                    return (
                        <div key={messageId} className={styles.responseWrapper}>
                            <TextContainer
                                title={HeaderComponent}
                                content={text}
                                subheader={
                                    <ThinkingSection
                                        steps={thinkingSteps ?? []}
                                        isThinking={isThinkingPhase}
                                        durationMs={thinkingDurationMs}
                                    />
                                }
                                isLoading={isThinkingPhase}
                                loadingContent={null}
                                data-testid="response-message"
                                aria-label={t('conversation.response.responseFrom', { vendor: aiVendor })}
                            >
                                {error && (
                                    <div className={styles.errorBanner} role="alert" data-testid="response-error">
                                        {text.trim().length > 0
                                            ? t('conversation.response.streamInterrupted', { reason: error })
                                            : t('conversation.response.generationFailed', { reason: error })}
                                    </div>
                                )}
                                {!isLoading && (inputTokens != null || outputTokens != null || totalTokens != null || tokensReadFromCache != null) && (
                                    <div className={styles.tokenBadge}>
                                        {inputTokens != null && (
                                            <Tooltip content={t('conversation.response.totalInputTokens')}>
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.INPUT_TOKENS} size={12} />
                                                    {inputTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {outputTokens != null && (
                                            <Tooltip content={t('conversation.response.totalOutputTokens')}>
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.OUTPUT_TOKENS} size={12} />
                                                    {outputTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {tokensReadFromCache != null && (
                                            <Tooltip content={t('conversation.response.tokensReadFromCache')}>
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.CACHE_TOKENS} size={12} />
                                                    {tokensReadFromCache.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                        {totalTokens != null && (
                                            <Tooltip content={t('conversation.response.totalTokens')}>
                                                <span className={styles.tokenItem}>
                                                    <Icon src={ICONS.TOTAL_TOKENS} size={12} />
                                                    {totalTokens.toLocaleString()}
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                )}
                                {(isLoading || isLastResponseBlock) && (
                                    <div className={styles.responseActionButtonsWrapper}>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            {isLoading ? (
                                                <MultiPurposeButton
                                                    label={t('conversation.response.stop')}
                                                    onClick={() => stopGenerating(blockId, aiVendor as AIVendor)}
                                                    data-testid="stop-button"
                                                />
                                            ) : (
                                                <>
                                                    <Tooltip content={disabled ? t('conversation.response.noApiKeysSet') : ""}>
                                                        <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                                            <MultiPurposeButton
                                                                label={t('conversation.response.regenerate')}
                                                                onClick={() => handleRegenerate(aiVendor as AIVendor)}
                                                                disabled={disabled}
                                                                icon={ICONS.REFRESH_ICON}
                                                                data-testid="regenerate-button"
                                                            />
                                                        </div>
                                                    </Tooltip>

                                                    {onFollowUp && text.trim().length > 0 && (
                                                        <Tooltip content={disabled ? t('conversation.response.noApiKeysSet') : ""}>
                                                            <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                                                <MultiPurposeButton
                                                                    label={isSelected ? t('conversation.response.selected') : t('conversation.response.followUp')}
                                                                    onClick={() => handleFollowUp(messageId)}
                                                                    disabled={isSelected || disabled}
                                                                    icon={isSelected ? undefined : ICONS.SEND}
                                                                    data-testid="follow-up-button"
                                                                />
                                                            </div>
                                                        </Tooltip>
                                                    )}
                                                </>
                                            )}
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
