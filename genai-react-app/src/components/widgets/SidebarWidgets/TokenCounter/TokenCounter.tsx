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
    const { editorPrompt } = conversation
    const { supplementalText, config } = ai

    const [tokenCount, setTokenCount] = useState(0)
    const [isTokenLoading, setIsTokenLoading] = useState(false)

    useEffect(() => {
        const calculateTokens = async () => {
            const fullText = (editorPrompt || '') + (supplementalText || '')
            if (!fullText.trim()) {
                setTokenCount(0)
                return
            }

            // 3. Get Model (Assumes OpenAI for counting)
            // 3. Get Model (Assumes OpenAI for counting)
            const openaiConfig = config.find(c => c.aiVendor === AIVendor.OPENAI && !!c.model?.trim())
            // Fallback to gpt-4o if no config found (for debugging/robustness)
            const model = openaiConfig?.model || 'gpt-4o'

            console.log('[TokenCounter] Debug:', {
                editorPromptLength: editorPrompt?.length,
                supplementalTextLength: supplementalText?.length,
                configLength: config?.length,
                foundModel: model,
                fullTextLength: fullText.length,
                usingFallback: !openaiConfig?.model
            })

            if (!model) {
                // Should be unreachable now with fallback
                setTokenCount(0)
                return
            }

            setIsTokenLoading(true)
            try {
                const count = await countTokens(fullText, model)
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
    }, [editorPrompt, supplementalText, config])

    // Collapsed Content
    const headerCollapsed = (
        <Tooltip content="Tokens" position="left">
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
            <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-secondary)', margin: 0 }}>Tokens</h3>
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
                    {isTokenLoading ? 'Counting tokens…' : `Tokens: ${tokenCount}`}
                </div>
            </div>
        </SidebarWidgetContainer>
    )
}
