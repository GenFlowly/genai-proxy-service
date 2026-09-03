import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ICONS } from '../../../../constants/icons'
import styles from './Response.module.scss'
import { useLayout } from '../../../../context/LayoutContext'
import { useConversation } from '../../../../context/ConversationContext'
import { TextContainer } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import { LearnedFact, Message, ThinkingStep, WebSource } from "../../../../models/conversation.models";
import ThinkingSteps from './ThinkingSteps'
import { useLearnedFacts } from '../../../../hooks/useLearnedFacts'
import { RectangleButton } from '@genflowly/component-library'
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

/**
 * Turn bare [n] citation markers into markdown links to their web source, so
 * the markdown renderer makes them clickable. Only indices that exist in
 * webSources are linked — the model can occasionally emit a stray marker, and
 * an unknown index is left as plain text rather than a dead link. Markers
 * already followed by "(" are part of an existing markdown link and skipped.
 */
function linkifyCitations(text: string, webSources?: WebSource[] | null): string {
    if (!text || !webSources || webSources.length === 0) return text
    const byIndex = new Map(webSources.map(s => [s.index, s.url]))
    return text.replace(/\[(\d{1,3})\](?!\()/g, (marker, n) => {
        const url = byIndex.get(Number(n))
        return url ? `[${marker}](${url})` : marker
    })
}

/** "$1.23" / "$0.0421" — sub-dollar amounts keep enough decimals for sub-cent turn costs. */
function formatUsd(cost: number): string {
    return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`
}

/** Numbered link list rendered under the response text. */
function SourcesSection({ sources }: { sources: WebSource[] }) {
    const { t } = useTranslation()
    return (
        <div className={styles.sourcesSection} data-testid="sources-section">
            <div className={styles.sourcesLabel}>{t('conversation.response.sources')}</div>
            <ul className={styles.sourcesList}>
                {sources.map(source => (
                    <li key={source.index}>
                        <span className={styles.sourceIndex}>[{source.index}]</span>
                        <a
                            className={styles.sourceLink}
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={source.url}
                        >
                            {source.title || source.url}
                        </a>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/**
 * Placeholder message ids assigned client-side before the backend echoes the
 * real one (stream placeholders / synthesized error cards). There is nothing
 * to poll for under such an id.
 */
const PLACEHOLDER_MESSAGE_ID = /^(resp|error)-/

/**
 * "Facts learned about the user" item in the response footer stats row.
 * Pending → muted pulsing "Learning facts…" while the async extraction runs;
 * done with facts → count with an interactive tooltip listing each fact and a
 * ✗ that deletes it from memory; done without facts → muted "No new facts".
 */
function LearnedFactsStat({ conversationId, messageId, initialFacts, isFreshResponse }: {
    conversationId: string
    messageId: string
    initialFacts: LearnedFact[] | null | undefined
    isFreshResponse: boolean
}) {
    const { t } = useTranslation()
    const { status, facts, removeFact } = useLearnedFacts(conversationId, messageId, initialFacts, isFreshResponse)

    const handleDelete = async (memoryId: string) => {
        try {
            await removeFact(memoryId)
        } catch (e) {
            // Real failure (not a 404): keep the fact listed so the user can retry
            console.error('Failed to delete memory fact', e)
        }
    }

    if (status === 'pending') {
        return (
            <span className={`${styles.tokenItem} ${styles.learnedFactsPending}`} data-testid="learned-facts-pending">
                <span className={styles.pulse} />
                {t('conversation.response.learningFacts')}
            </span>
        )
    }

    if (facts.length === 0) {
        return (
            <span className={`${styles.tokenItem} ${styles.learnedFactsNone}`} data-testid="learned-facts-none">
                {t('conversation.response.noNewFacts')}
            </span>
        )
    }

    return (
        <Tooltip
            interactive
            content={
                <ul className={styles.learnedFactsList} data-testid="learned-facts-list">
                    {facts.map(fact => (
                        <li key={fact.memoryId} className={styles.learnedFactItem}>
                            <span className={styles.learnedFactText}>{fact.text}</span>
                            <button
                                className={styles.learnedFactDelete}
                                onClick={() => handleDelete(fact.memoryId)}
                                aria-label={t('conversation.response.deleteFact', { fact: fact.text })}
                                data-testid="learned-fact-delete"
                            >
                                ✗
                            </button>
                        </li>
                    ))}
                </ul>
            }
        >
            <span className={styles.tokenItem} data-testid="learned-facts-count">
                {t('conversation.response.factsAddedToMemory', { count: facts.length })}
            </span>
        </Tooltip>
    )
}

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
function ThinkingSection({ steps, stepList, isThinking, durationMs }: { steps: string[], stepList?: ThinkingStep[] | null, isThinking: boolean, durationMs?: number | null }) {
    const { t } = useTranslation()
    const [isExpanded, setIsExpanded] = useState(true)

    // Auto-collapse once the answer starts streaming
    useEffect(() => {
        if (!isThinking) setIsExpanded(false)
    }, [isThinking])

    // Legacy flat "k" strings become plain steps (label only, no icon) so the
    // whole section renders through one component; structured "ks" steps follow
    const displaySteps: ThinkingStep[] = useMemo(() => [
        ...steps.map((step, i): ThinkingStep => ({ node: `legacy-${i}`, name: step, status: 'done' })),
        ...(stepList ?? []),
    ], [steps, stepList])

    if (displaySteps.length === 0 && !isThinking) return null

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
            {isExpanded && <ThinkingSteps steps={displaySteps} />}
        </div>
    )
}

export default function Response({ blockId, responseMessages, onFollowUp, disabled = false, isLastResponseBlock = true, 'data-testid': testId }: ResponseProps & { 'data-testid'?: string }) {
    const { t } = useTranslation()
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { setSelectedResponseForBlock, getSelectedResponseForBlock, generateResponsesStream, getVendorSelectionForBlock, setVendorSelectionForBlock, stopGenerating, conversationBlockList = [], conversationId = '' } = useConversation()

    // Running per-vendor totals (tokens + exact cost) up to and including each
    // response, keyed by messageId. The badge shows these conversation-so-far
    // numbers on every response; a single turn's usage is the difference
    // between consecutive responses of the same vendor.
    const cumulativeByMessage = useMemo(() => {
        type Totals = { inputTokens: number; outputTokens: number; totalTokens: number; tokensReadFromCache: number; costUsd: number | null }
        const perVendor: Partial<Record<string, Totals>> = {}
        const byMessage: Partial<Record<string, Totals>> = {}
        for (const block of conversationBlockList) {
            for (const msg of block.responseMessages) {
                if (!msg.aiVendor) continue
                const hasUsage = msg.inputTokens != null || msg.outputTokens != null || msg.totalTokens != null || msg.costUsd != null
                if (!hasUsage) continue
                const prev = perVendor[msg.aiVendor] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensReadFromCache: 0, costUsd: null }
                const next: Totals = {
                    inputTokens: prev.inputTokens + (msg.inputTokens ?? 0),
                    outputTokens: prev.outputTokens + (msg.outputTokens ?? 0),
                    totalTokens: prev.totalTokens + (msg.totalTokens ?? 0),
                    tokensReadFromCache: prev.tokensReadFromCache + (msg.tokensReadFromCache ?? 0),
                    costUsd: msg.costUsd != null ? (prev.costUsd ?? 0) + msg.costUsd : prev.costUsd,
                }
                perVendor[msg.aiVendor] = next
                byMessage[msg.messageId] = next
            }
        }
        return byMessage
    }, [conversationBlockList])

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
                {filteredResponseList.map(({ aiVendor, model, text, messageId, isLoading, error, thinkingSteps, thinkingStepList, thinkingDurationMs, webSources, inputTokens, outputTokens, totalTokens, tokensReadFromCache, costUsd, learnedFacts }) => {
                    const isSelected = selectedResponseId === messageId
                    const isThinkingPhase = !!isLoading && text.trim().length === 0

                    // Only a response generated in THIS session (learnedFacts
                    // never set — historical loads always set it, if only to
                    // null) with a real backend message id has an async memory
                    // extraction worth polling for. Errored/aborted messages
                    // never reached extraction.
                    const isFreshResponse = learnedFacts === undefined
                        && !error
                        && !!conversationId
                        && !!messageId
                        && !PLACEHOLDER_MESSAGE_ID.test(messageId)

                    // Conversation-so-far totals for this response's vendor; a
                    // response not (yet) in the block list — e.g. rendered in
                    // isolation — falls back to its own per-turn values.
                    const hasOwnUsage = inputTokens != null || outputTokens != null || totalTokens != null || tokensReadFromCache != null || costUsd != null
                    const usageTotals = cumulativeByMessage[messageId] ?? (hasOwnUsage ? {
                        inputTokens: inputTokens ?? 0,
                        outputTokens: outputTokens ?? 0,
                        totalTokens: totalTokens ?? 0,
                        tokensReadFromCache: tokensReadFromCache ?? 0,
                        costUsd: costUsd ?? null,
                    } : undefined)

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
                                content={linkifyCitations(text, webSources)}
                                subheader={
                                    <ThinkingSection
                                        steps={thinkingSteps ?? []}
                                        stepList={thinkingStepList}
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
                                {!isLoading && webSources && webSources.length > 0 && (
                                    <SourcesSection sources={webSources} />
                                )}
                                {!isLoading && usageTotals && (
                                    <div className={styles.tokenBadge}>
                                        <Tooltip content={t('conversation.response.totalInputTokens')}>
                                            <span className={styles.tokenItem}>
                                                <Icon src={ICONS.INPUT_TOKENS} size={12} />
                                                {usageTotals.inputTokens.toLocaleString()}
                                            </span>
                                        </Tooltip>
                                        <Tooltip content={t('conversation.response.totalOutputTokens')}>
                                            <span className={styles.tokenItem}>
                                                <Icon src={ICONS.OUTPUT_TOKENS} size={12} />
                                                {usageTotals.outputTokens.toLocaleString()}
                                            </span>
                                        </Tooltip>
                                        <Tooltip content={t('conversation.response.tokensReadFromCache')}>
                                            <span className={styles.tokenItem}>
                                                <Icon src={ICONS.CACHE_TOKENS} size={12} />
                                                {usageTotals.tokensReadFromCache.toLocaleString()}
                                            </span>
                                        </Tooltip>
                                        <Tooltip content={t('conversation.response.totalTokens')}>
                                            <span className={styles.tokenItem}>
                                                <Icon src={ICONS.TOTAL_TOKENS} size={12} />
                                                {usageTotals.totalTokens.toLocaleString()}
                                            </span>
                                        </Tooltip>
                                        {usageTotals.costUsd != null && (
                                            <Tooltip content={t('conversation.response.conversationCostUsd', { vendor: aiVendor })}>
                                                <span className={styles.tokenItem}>
                                                    {formatUsd(usageTotals.costUsd)}
                                                </span>
                                            </Tooltip>
                                        )}
                                        <LearnedFactsStat
                                            conversationId={conversationId}
                                            messageId={messageId}
                                            initialFacts={learnedFacts}
                                            isFreshResponse={isFreshResponse}
                                        />
                                    </div>
                                )}
                                {(isLoading || isLastResponseBlock) && (
                                    <div className={styles.responseActionButtonsWrapper}>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            {isLoading ? (
                                                <RectangleButton
                                                    label={t('conversation.response.stop')}
                                                    onClick={() => stopGenerating(blockId, aiVendor as AIVendor)}
                                                    data-testid="stop-button"
                                                />
                                            ) : (
                                                <>
                                                    <Tooltip content={disabled ? t('conversation.response.noApiKeysSet') : ""}>
                                                        <div style={disabled ? { cursor: 'not-allowed' } : {}}>
                                                            <RectangleButton
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
                                                                <RectangleButton
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
