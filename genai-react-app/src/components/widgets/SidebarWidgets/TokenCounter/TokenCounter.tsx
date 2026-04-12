import React, { useState, useEffect } from 'react'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import Tooltip from '../../../common/Tooltip/Tooltip'
import { countTokens } from '../../../../utils/tokenizer'
import { AIVendor } from '../../../../constants/vendors'

export default function TokenCounter({ 'data-testid': testId }: { 'data-testid'?: string } = {}) {
    const { conversation, ai } = useSidebarWidget()
    const { editorPrompt, activeBlockId, conversationBlockList } = conversation
    const { config } = ai

    // PromptEditor is only rendered when the active block is not yet resolved
    const activeBlock = conversationBlockList.find(b => b.conversationBlockId === activeBlockId)
    const promptEditorVisible = !!activeBlock && !(activeBlock.status === 'resolved' && !activeBlock.isLoading)

    const [tokenCount, setTokenCount] = useState(0)
    const [isTokenLoading, setIsTokenLoading] = useState(false)

    useEffect(() => {
        const calculateTokens = async () => {
            const text = promptEditorVisible ? (editorPrompt || '') : ''
            if (!text.trim()) {
                setTokenCount(0)
                return
            }

            const openaiConfig = config.find(c => c.aiVendor === AIVendor.OPENAI && !!c.model?.trim())
            const model = openaiConfig?.model || 'gpt-4o'

            setIsTokenLoading(true)
            try {
                const count = await countTokens(text, model)
                setTokenCount(count)
            } catch (err) {
                console.error('Token counting failed:', err)
                setTokenCount(0)
            } finally {
                setIsTokenLoading(false)
            }
        }

        const timeout = setTimeout(calculateTokens, 500)
        return () => clearTimeout(timeout)
    }, [editorPrompt, promptEditorVisible, config])

    // Collapsed Content
    const headerCollapsed = (
        <Tooltip content="Prompt Tokens" position="left">
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
            {isTokenLoading ? '...' : tokenCount}
        </div>
    )

    // Expanded Header
    const header = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.25rem' }}>
            <Icon src={ICONS.TOKENS} size={20} />
            <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-secondary)', margin: 0 }}>Prompt Tokens</h3>
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
                    {isTokenLoading ? 'Counting tokens…' : `Estimated: ${tokenCount}`}
                </div>
            </div>
        </SidebarWidgetContainer>
    )
}
