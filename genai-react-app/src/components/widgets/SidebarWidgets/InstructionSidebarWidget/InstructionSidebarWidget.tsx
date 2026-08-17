import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAI } from '../../../../context/AIContext'
import { useLayout } from '../../../../context/LayoutContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../../constants/icons'
import { Tooltip } from '@genflowly/component-library'
import styles from './InstructionSidebarWidget.module.scss'

export default function InstructionSidebarWidget() {
    const { t } = useTranslation()
    const { systemPrompt } = useAI()
    const { isLeftSidebarExpanded, setInstructionWidgetExpanded, isInstructionWidgetExpanded } = useLayout()
    const collapsed = !isLeftSidebarExpanded

    const handleClick = () => {
        const newState = !isInstructionWidgetExpanded
        setInstructionWidgetExpanded(newState)

        // Scroll to instruction widget only if expanding
        if (newState) {
            setTimeout(() => {
                const element = document.getElementById('instruction-widget-scroll-anchor')
                if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
            }, 100)
        }
    }

    const content = (
        <button
            className={`${styles.instructionItem} ${collapsed ? styles.collapsed : ''}`}
            onClick={handleClick}
            data-testid="instruction-widget-toggle"
            aria-expanded={isInstructionWidgetExpanded}
        >
            <span className={styles.icon}>
                <Icon src={ICONS.USER_ROLE} />
            </span>
            {!collapsed && <span className={styles.text}>{t('sidebar.instructionSidebarWidget.instructions')}</span>}
        </button>
    )

    // Show tooltip on hover with system prompt text
    // If empty, show "Instructions"
    const tooltipContent = systemPrompt || t('sidebar.instructionSidebarWidget.instructions')

    // If collapsed, we might want to also show "Instructions" label or just the prompt
    // User requirement: "when i hover, it will show instructions in tooltip"

    return (
        <div className={styles.widgetContainer}>
            <Tooltip content={tooltipContent} position="right">
                {content}
            </Tooltip>
        </div>
    )
}
