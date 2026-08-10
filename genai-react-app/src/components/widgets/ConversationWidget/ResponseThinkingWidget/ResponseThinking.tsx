import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Message } from '../../../../models/conversation.models'
import { AIVendor } from '../../../../constants/vendors'
import TextContainer from '../../../common/TextContainer/TextContainer'
import { OpenAIBrandName, ClaudeBrandName, GeminiBrandName } from '../../../common/BrandName/BrandName'
import { useLayout } from '../../../../context/LayoutContext'
import { useConversation } from '../../../../context/ConversationContext'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import ToggleGroupButton, { ToggleOption } from '../../../common/ToggleGroupButton/ToggleGroupButton'
import { useMaxVendors } from '../../../../hooks/useMaxVendors'
import styles from './ResponseThinking.module.scss'

interface ResponseThinkingProps {
    blockId: string
    responseMessages: Message[]
}

export default function ResponseThinking({ blockId, responseMessages }: ResponseThinkingProps) {
    const { isLeftSidebarExpanded, isRightSidebarExpanded } = useLayout()
    const { getVendorSelectionForBlock, setVendorSelectionForBlock } = useConversation()
    const sidebarsHidden = !isLeftSidebarExpanded && !isRightSidebarExpanded

    const [isExpanded, setIsExpanded] = useState(true)

    const availableVendors = useMemo(() => {
        const vendors = new Set<string>()
        responseMessages.forEach(msg => {
            if (msg.aiVendor && (msg.text.length > 0 || msg.isLoading)) {
                vendors.add(msg.aiVendor)
            }
        })
        return Array.from(vendors)
    }, [responseMessages])

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
    const rawSelectedVendors = selectedVendors.length > 0 ? selectedVendors : availableVendors
    const effectiveSelectedVendors = rawSelectedVendors.slice(0, maxVendors)

    const toggleOptions: ToggleOption[] = useMemo(() => availableVendors.map(vendor => ({
        id: vendor,
        label: vendor === AIVendor.OPENAI ? 'OpenAI' :
            vendor === AIVendor.CLAUDE ? 'Claude' :
                vendor === AIVendor.GEMINI ? 'Gemini' : vendor,
        icon: vendor === AIVendor.OPENAI ? ICONS.OPENAI :
            vendor === AIVendor.CLAUDE ? ICONS.CLAUDE :
                vendor === AIVendor.GEMINI ? ICONS.GEMINI : undefined
    })), [availableVendors])

    const thinkingMessages = responseMessages.filter(msg =>
        effectiveSelectedVendors.includes(msg.aiVendor) &&
        ((msg.thinkingSteps?.length ?? 0) > 0 || (!!msg.isLoading && msg.text.trim().length === 0))
    )

    const anyStillThinking = thinkingMessages.some(
        msg => !!msg.isLoading && msg.text.trim().length === 0
    )

    useEffect(() => {
        if (!anyStillThinking) setIsExpanded(false)
    }, [anyStillThinking])

    if (availableVendors.length === 0) return null

    const hasVisibleThinking = thinkingMessages.length > 0

    return (
        <div className={styles.container} data-response-block-id={blockId}>
            {availableVendors.length > 1 && (
                <div className={styles.toggleWrapper}>
                    <ToggleGroupButton
                        options={toggleOptions}
                        selectedValues={effectiveSelectedVendors}
                        onChange={(vendors) => setVendorSelectionForBlock(blockId, vendors)}
                        allowEmpty={false}
                        maxSelection={maxVendors}
                    />
                </div>
            )}

            {hasVisibleThinking && (
                <div className={`${styles.inner} ${sidebarsHidden ? styles.sideBySide : ''}`}>
                    {thinkingMessages.map(msg => {
                        const steps = msg.thinkingSteps ?? []
                        const isThinkingPhase = !!msg.isLoading && msg.text.trim().length === 0

                        let HeaderComponent: React.ReactNode = null
                        if (msg.aiVendor === AIVendor.OPENAI) HeaderComponent = <OpenAIBrandName as="span" />
                        else if (msg.aiVendor === AIVendor.CLAUDE) HeaderComponent = <ClaudeBrandName as="span" />
                        else if (msg.aiVendor === AIVendor.GEMINI) HeaderComponent = <GeminiBrandName as="span" />
                        else HeaderComponent = <span>{msg.aiVendor}</span>

                        const content = steps.map(s => `- ${s}`).join('\n')

                        const titleNode = (
                            <>
                                {HeaderComponent}
                                <button className={styles.toggleButton} onClick={() => setIsExpanded(prev => !prev)} aria-expanded={isExpanded}>
                                    {isThinkingPhase && <span className={styles.pulse} />}
                                    <span className={styles.label}>Thinking</span>
                                    <span className={styles.chevron}>{isExpanded ? '▼' : '▶'}</span>
                                </button>
                            </>
                        )

                        return (
                            <div key={msg.messageId} className={styles.thinkingWrapper}>
                                <TextContainer
                                    title={titleNode}
                                    content={isExpanded ? content : ''}
                                    showCopyButton={false}
                                    isLoading={isThinkingPhase && isExpanded && steps.length === 0}
                                    loadingContent={
                                        <div className={styles.placeholder}>
                                            <Icon src={ICONS.THINK} size={14} />
                                            <span>Thinking...</span>
                                        </div>
                                    }
                                />
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
