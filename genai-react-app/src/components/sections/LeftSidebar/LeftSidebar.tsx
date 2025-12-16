import React from 'react'
import { useLayout } from '../../../context/LayoutContext'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import ThreadWidget from '../../widgets/ThreadWidget/ThreadWidget'
import styles from './LeftSidebar.module.scss'

export default function LeftSidebar(): React.ReactElement {
    const { isLeftSidebarExpanded, toggleLeftSidebar } = useLayout()

    return (
        <aside className={styles.sidebar}>
            <button
                onClick={toggleLeftSidebar}
                className={styles.collapseButton}
                title={isLeftSidebarExpanded ? 'Collapse Sidebar' : 'Expand Sidebar'}
            >
                {isLeftSidebarExpanded ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
            </button>

            <ThreadWidget />
        </aside>
    )
}
