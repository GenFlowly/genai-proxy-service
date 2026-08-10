import React, { useEffect } from 'react'
import Navbar from '../../components/navbar/Navbar'
import NotesHeader from '../../components/widgets/NotesHeader/NotesHeader'
import LeftSidebar from '../../components/sections/LeftSidebar/LeftSidebar'
import RightSidebar from '../../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../../components/sections/CenterSection/CenterSection'
import styles from './MemoryPage.module.scss'
import { getPageConfig } from '../../config/PageWidgetConfig'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { NotesProvider } from '../../context/NotesContext'

export default function MemoryPage() {
    const config = getPageConfig('MEMORY_PAGE')
    const { setRightSidebarExpanded, setLeftSidebarExpanded } = useLayout()
    usePageTitle()

    useEffect(() => {
        setRightSidebarExpanded(false)
        setLeftSidebarExpanded(true)
    }, [setRightSidebarExpanded, setLeftSidebarExpanded])

    return (
        <NotesProvider>
            <div className={styles.page}>
                <Navbar />
                <NotesHeader />
                <div className={styles.layout}>
                    <LeftSidebar widgetIds={config.leftSidebar} />
                    <CenterSection widgetIds={config.centerSection} />
                    <RightSidebar widgetIds={config.rightSidebar} />
                </div>
            </div>
        </NotesProvider>
    )
}
