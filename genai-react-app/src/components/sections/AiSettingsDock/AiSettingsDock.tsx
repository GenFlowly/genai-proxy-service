import React from 'react'
import { useTranslation } from 'react-i18next'
import { CollapseStrip, MobileFullPageModal, SidebarRail, SidebarStack } from '@genflowly/component-library'
import { useLayout } from '../../../context/LayoutContext'
import { useResponsiveBreakpoints } from '../../../hooks/useResponsiveBreakpoints'
import { ICONS } from '../../../constants/icons'
import AIVendorWidget from '../../widgets/SidebarWidgets/AIVendorWidget/AIVendorWidget'
import AgentPickerWidget from '../../widgets/SidebarWidgets/AgentPickerWidget/AgentPickerWidget'
import TokenCounter from '../../widgets/SidebarWidgets/TokenCounter/TokenCounter'
import styles from './AiSettingsDock.module.scss'

/**
 * The chat page's AI settings: the Models, Agent and Tokens cards. A dock on
 * the right on desktop, collapsing to a 28px strip; the AI Settings modal on
 * phones.
 */
export default function AiSettingsDock(): React.ReactElement | null {
    const { t } = useTranslation()
    const { isNarrow } = useResponsiveBreakpoints()
    const {
        isAiDockExpanded,
        setAiDockExpanded,
        toggleAiDock,
        isRightSidebarExpanded,
        setRightSidebarExpanded,
    } = useLayout()

    const cards = (
        <>
            <AIVendorWidget />
            <AgentPickerWidget />
            <TokenCounter />
        </>
    )

    if (isNarrow) {
        if (!isRightSidebarExpanded) return null
        return (
            <MobileFullPageModal onClose={() => setRightSidebarExpanded(false)} data-testid="ai-settings-modal">
                <SidebarStack data-testid="ai-settings-modal-cards">{cards}</SidebarStack>
            </MobileFullPageModal>
        )
    }

    if (!isAiDockExpanded) {
        const expand = () => setAiDockExpanded(true)
        return (
            <SidebarRail
                side="right"
                aria-label={t('layout.aiDock.label')}
                items={[
                    { id: 'models', icon: ICONS.MODELS, label: t('sidebar.aiVendorWidget.title'), onClick: expand, testId: 'ai-dock-strip-models' },
                    { id: 'agent', icon: ICONS.USER_ROLE, label: t('sidebar.agentPickerWidget.title'), onClick: expand, testId: 'ai-dock-strip-agent' },
                    { id: 'tokens', icon: ICONS.TOKENS, label: t('sidebar.tokenCounter.title'), onClick: expand, testId: 'ai-dock-strip-tokens' },
                ]}
                expandLabel={t('layout.rightSidebar.expandSidebar')}
                onExpand={toggleAiDock}
                expandTestId="ai-dock-expand"
                data-testid="ai-dock-strip"
            />
        )
    }

    return (
        <aside className={styles.dock} aria-label={t('layout.aiDock.label')} data-testid="ai-dock">
            <SidebarStack data-testid="ai-dock-cards">{cards}</SidebarStack>
            <CollapseStrip
                direction="right"
                label={t('layout.rightSidebar.collapseSidebar')}
                onClick={toggleAiDock}
                aria-expanded={true}
                data-testid="ai-dock-collapse"
            />
        </aside>
    )
}
