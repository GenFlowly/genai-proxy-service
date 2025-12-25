import React from 'react'
import { useSidebarWidget } from '../../../hooks/useSidebarWidget'
import SidebarWidgetContainer from '../../common/SidebarWidgetContainer/SidebarWidgetContainer'
import PillButton from '../../common/PillButton/PillButton'
import { ICONS } from '../../../constants/icons'
import styles from './NewChatWidget.module.scss'
import Tooltip from '../../common/Tooltip/Tooltip'
import { Icon } from '../../common/Icon/Icon'

export default function NewChatWidget(): React.ReactElement {
    const { conversation } = useSidebarWidget()
    const { resetConversation } = conversation

    const collapsedContent = (
        <Tooltip content="New Chat" position="left">
            <button
                className={styles.collapsedButton}
                onClick={resetConversation}
            >
                <Icon src={ICONS.PLUS} size={20} />
            </button>
        </Tooltip>
    )

    return (
        <SidebarWidgetContainer collapsedContent={collapsedContent}>
            <div className={styles.container}>
                <PillButton
                    label="New Chat"
                    onClick={resetConversation}
                    icon={ICONS.PLUS}
                    className={styles.fullWidthButton}
                />
            </div>
        </SidebarWidgetContainer>
    )
}
