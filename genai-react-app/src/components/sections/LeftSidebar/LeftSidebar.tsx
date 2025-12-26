import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import ThreadWidget from '../../widgets/SidebarWidgets/ThreadWidget/ThreadWidget'
import styles from './LeftSidebar.module.scss'

export default function LeftSidebar(): React.ReactElement {
    const { isLeftSidebarExpanded, toggleLeftSidebar } = useLayout()
    const collapsed = !isLeftSidebarExpanded

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>


            <div className={styles.sidebarContent}>
                <ThreadWidget />
            </div>
        </aside>
    )
}
