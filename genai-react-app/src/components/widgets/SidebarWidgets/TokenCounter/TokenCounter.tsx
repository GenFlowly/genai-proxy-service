import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, SidebarCard, Tooltip, conversationUsageByVendor, formatUsd } from '@genflowly/component-library'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import { useVendorDisplayNames } from '../../../../hooks/useVendorDisplayNames'
import { ICONS } from '../../../../constants/icons'
import { estimateTokens } from '../../../../utils/tokenEstimate'
import { useConversationUI } from '../../../../context/ConversationContext'
import styles from './TokenCounter.module.scss'

/**
 * The Tokens card: the prompt being typed, estimated, and every vendor's
 * usage and cost in this conversation so far.
 */
export default function TokenCounter({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { t } = useTranslation()
    const { conversation } = useSidebarWidget()
    const { activeBlockId, conversationBlockList } = conversation
    const { editorPrompt } = useConversationUI()
    const vendorName = useVendorDisplayNames()

    // The editor only shows while the active block is not yet resolved
    const activeBlock = conversationBlockList.find(b => b.conversationBlockId === activeBlockId)
    const textEditorVisible = !!activeBlock && !(activeBlock.status === 'resolved' && !activeBlock.isLoading)

    const [tokenCount, setTokenCount] = useState(0)

    useEffect(() => {
        // Estimation is cheap; the debounce only throttles re-renders while typing
        const timeout = setTimeout(() => {
            const text = textEditorVisible ? (editorPrompt || '') : ''
            setTokenCount(text.trim() ? estimateTokens(text) : 0)
        }, 500)
        return () => clearTimeout(timeout)
    }, [editorPrompt, textEditorVisible])

    const usage = useMemo(() => conversationUsageByVendor(conversationBlockList), [conversationBlockList])

    return (
        <SidebarCard
            title={t('sidebar.tokenCounter.title')}
            icon={ICONS.TOKENS}
            bodyClassName={styles.body}
            data-testid={testId || 'token-counter-widget'}
        >
            <div className={styles.row}>
                <span className={styles.key}>{t('sidebar.tokenCounter.promptEstimated')}</span>
                <span className={styles.value} data-testid="token-count-display">{tokenCount.toLocaleString()}</span>
            </div>
            <div className={styles.sectionLabel}>{t('sidebar.tokenCounter.thisConversation')}</div>
            {usage.length === 0 && (
                <div className={styles.empty} data-testid="token-usage-empty">{t('sidebar.tokenCounter.noUsageYet')}</div>
            )}
            {usage.map(vendor => (
                <div key={vendor.vendor} className={styles.vendor} data-testid={`token-usage-${vendor.vendor}`}>
                    <div className={styles.row}>
                        <span className={styles.vendorName}>{vendorName(vendor.vendor)}</span>
                        {vendor.costUsd != null && (
                            <Tooltip content={t('conversation.response.conversationCostUsd', { vendor: vendorName(vendor.vendor) })} position="left">
                                <span className={styles.value}>{formatUsd(vendor.costUsd)}</span>
                            </Tooltip>
                        )}
                    </div>
                    <div className={styles.grid}>
                        <Tooltip content={t('conversation.response.totalInputTokens')} position="left">
                            <span className={styles.stat}>
                                <Icon src={ICONS.INPUT_TOKENS} size={12} />
                                {vendor.inputTokens.toLocaleString()}
                            </span>
                        </Tooltip>
                        <Tooltip content={t('conversation.response.totalOutputTokens')} position="left">
                            <span className={styles.stat}>
                                <Icon src={ICONS.OUTPUT_TOKENS} size={12} />
                                {vendor.outputTokens.toLocaleString()}
                            </span>
                        </Tooltip>
                        <Tooltip content={t('conversation.response.tokensReadFromCache')} position="left">
                            <span className={styles.stat}>
                                <Icon src={ICONS.CACHE_TOKENS} size={12} />
                                {vendor.tokensReadFromCache.toLocaleString()}
                            </span>
                        </Tooltip>
                        <Tooltip content={t('conversation.response.totalTokens')} position="left">
                            <span className={styles.stat}>
                                <Icon src={ICONS.TOTAL_TOKENS} size={12} />
                                {vendor.totalTokens.toLocaleString()}
                            </span>
                        </Tooltip>
                    </div>
                </div>
            ))}
        </SidebarCard>
    )
}
