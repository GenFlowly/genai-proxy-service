import React from 'react'
import { useSidebarWidget } from '../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import Tooltip from '../../common/Tooltip/Tooltip'

export default function TokenCounter() {
    const { ai } = useSidebarWidget()
    const { tokenCount, isTokenLoading } = ai

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
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', textAlign: 'center', width: '100%' }}>
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
        >
            <div style={{ display: 'flex', flexDirection: 'column', padding: '0 0.25rem' }}>
                <div className="text-xs text-gray-500">
                    {isTokenLoading ? 'Counting tokens…' : `Tokens: ${tokenCount}`}
                </div>
            </div>
        </SidebarWidgetContainer>
    )
}
