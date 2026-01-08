import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import ThreadWidget from '../../widgets/SidebarWidgets/ThreadWidget/ThreadWidget'
import InstructionSidebarWidget from '../../widgets/SidebarWidgets/InstructionSidebarWidget/InstructionSidebarWidget'
import styles from './LeftSidebar.module.scss'

export default function LeftSidebar({ 'data-testid': testId }: { 'data-testid'?: string } = {}): React.ReactElement {
    const { isLeftSidebarExpanded } = useLayout()
    const collapsed = !isLeftSidebarExpanded

    return (
        <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`} data-testid={testId || "left-sidebar"}>


            <div className={styles.sidebarContent}>
                <InstructionSidebarWidget />
                <ThreadWidget />
            </div>
        </aside>
    )
}
