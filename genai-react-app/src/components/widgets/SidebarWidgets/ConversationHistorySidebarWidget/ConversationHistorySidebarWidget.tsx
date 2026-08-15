import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLayout } from '../../../../context/LayoutContext'
import { Icon } from '../../../common/Icon/Icon'
import { ICONS } from '../../../../constants/icons'
import Tooltip from '../../../common/Tooltip/Tooltip'
import styles from '../InstructionSidebarWidget/InstructionSidebarWidget.module.scss'

export default function ConversationHistorySidebarWidget() {
    const { t } = useTranslation()
    const { isLeftSidebarExpanded, setHistoryWidgetExpanded, isHistoryWidgetExpanded } = useLayout()
    const collapsed = !isLeftSidebarExpanded

    const handleClick = () => {
        setHistoryWidgetExpanded(!isHistoryWidgetExpanded)
    }

    const content = (
        <button
            className={`${styles.instructionItem} ${collapsed ? styles.collapsed : ''}`}
            onClick={handleClick}
            data-testid="history-widget-toggle"
            aria-expanded={isHistoryWidgetExpanded}
        >
            <span className={styles.icon}>
                <Icon src={ICONS.MENU} />
            </span>
            {!collapsed && <span className={styles.text}>{t('sidebar.conversationHistorySidebarWidget.history')}</span>}
        </button>
    )

    return (
        <div className={styles.widgetContainer}>
            <Tooltip content={t('sidebar.conversationHistorySidebarWidget.toggleHistory')} position="right">
                {content}
            </Tooltip>
        </div>
    )
}
