import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import Tooltip from '../../../common/Tooltip/Tooltip'
import { estimateTokens } from '../../../../utils/tokenEstimate'

export default function TokenCounter({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { t } = useTranslation()
    const { conversation } = useSidebarWidget()
    const { editorPrompt, activeBlockId, conversationBlockList } = conversation

    // PromptEditor is only rendered when the active block is not yet resolved
    const activeBlock = conversationBlockList.find(b => b.conversationBlockId === activeBlockId)
    const promptEditorVisible = !!activeBlock && !(activeBlock.status === 'resolved' && !activeBlock.isLoading)

    const [tokenCount, setTokenCount] = useState(0)

    useEffect(() => {
        // Estimation is cheap; the debounce only throttles re-renders while typing
        const timeout = setTimeout(() => {
            const text = promptEditorVisible ? (editorPrompt || '') : ''
            setTokenCount(text.trim() ? estimateTokens(text) : 0)
        }, 500)
        return () => clearTimeout(timeout)
    }, [editorPrompt, promptEditorVisible])

    // Collapsed Content
    const headerCollapsed = (
        <Tooltip content={t('sidebar.tokenCounter.promptTokens')} position="left">
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '2.6rem',
                height: '2.6rem',
                cursor: 'default'
            }}>
                <Icon src={ICONS.TOKENS} size={24} />
            </div>
        </Tooltip>
    )

    const collapsedContent = (
        <div
            style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', textAlign: 'center', width: '100%' }}
            data-testid="token-count-collapsed"
        >
            {tokenCount}
        </div>
    )

    // Expanded Header
    const header = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.25rem' }}>
            <Icon src={ICONS.TOKENS} size={20} />
            <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-secondary)', margin: 0 }}>{t('sidebar.tokenCounter.promptTokens')}</h3>
        </div>
    )

    return (
        <SidebarWidgetContainer
            header={header}
            headerCollapsed={headerCollapsed}
            collapsedContent={collapsedContent}
            data-testid={testId || "token-counter-widget"}
        >
            <div style={{ display: 'flex', flexDirection: 'column', padding: '0 0.25rem' }}>
                <div className="text-xs text-gray-500" data-testid="token-count-display">
                    {t('sidebar.tokenCounter.estimated', { tokenCount })}
                </div>
            </div>
        </SidebarWidgetContainer>
    )
}
