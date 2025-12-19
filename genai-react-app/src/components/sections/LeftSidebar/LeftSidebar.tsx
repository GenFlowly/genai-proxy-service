import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import ThreadWidget from '../../widgets/ThreadWidget/ThreadWidget'
import styles from './LeftSidebar.module.scss'

export default function LeftSidebar(): React.ReactElement {
    const { isLeftSidebarExpanded, toggleLeftSidebar } = useLayout()

    return (
        <aside className={`${styles.sidebar} ${!isLeftSidebarExpanded ? styles.collapsed : ''}`}>
            {/*<button*/}
            {/*    onClick={toggleLeftSidebar}*/}
            {/*    className={styles.collapseButton}*/}
            {/*    title={isLeftSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}*/}
            {/*>*/}
            {/*    {isLeftSidebarExpanded ? (*/}
            {/*        <Icon src={ICONS.ALT_ARROW_LEFT} size={20} />*/}
            {/*    ) : (*/}
            {/*        <Icon src={ICONS.ALT_ARROW_RIGHT} size={20} />*/}
            {/*    )}*/}
            {/*</button>*/}

            <ThreadWidget />
        </aside>
    )
}
