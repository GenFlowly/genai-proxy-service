import React from 'react'
import { useTranslation } from 'react-i18next'
import { useSidebarWidget } from '../../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import PillButton from '../../../common/PillButton/PillButton'
import { ICONS } from '../../../../constants/icons'
import styles from './NewChatWidget.module.scss'
import Tooltip from '../../../common/Tooltip/Tooltip'
import { Icon } from '../../../common/Icon/Icon'

export default function NewChatWidget({ 'data-testid': testId }: { 'data-testid'?: string } = {}): React.ReactElement {
    const { t } = useTranslation()
    const { conversation } = useSidebarWidget()
    const { resetConversation } = conversation

    const collapsedContent = (
        <Tooltip content={t('sidebar.newChatWidget.newChat')} position="left">
            <button
                className={styles.collapsedButton}
                onClick={resetConversation}
                data-testid="new-chat-button-collapsed"
            >
                <Icon src={ICONS.PLUS} size={20} />
            </button>
        </Tooltip>
    )

    return (
        <SidebarWidgetContainer collapsedContent={collapsedContent} data-testid={testId || "new-chat-widget"}>
            <div className={styles.container}>
                <PillButton
                    label={t('sidebar.newChatWidget.newChat')}
                    onClick={resetConversation}
                    icon={ICONS.PLUS}
                    className={styles.fullWidthButton}
                    variant={"secondary"}
                    data-testid="new-chat-button-expanded"
                />
            </div>
        </SidebarWidgetContainer>
    )
}
