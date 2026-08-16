import React, { useEffect } from 'react'
import Navbar from '../../components/navbar/Navbar'
import NotesHeader from '../../components/widgets/NotesHeader/NotesHeader'
import RightSidebar from '../../components/sections/RightSidebar/RightSidebar'
import CenterSection from '../../components/sections/CenterSection/CenterSection'
import ResizableSidebar from '../../components/common/ResizableSidebar/ResizableSidebar'
import SavedNotesWidget from '../../components/widgets/SidebarWidgets/SavedNotesWidget/SavedNotesWidget'
import styles from './MemoryPage.module.scss'
import { getPageConfig } from '../../config/PageWidgetConfig'
import { useLayout } from '../../context/LayoutContext'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { NotesProvider } from '../../context/NotesContext'

// Persisted width is stored in rem so it stays relative to the root font size
const SAVED_NOTES_WIDTH_STORAGE_KEY = 'saved_notes_width_rem'

export default function MemoryPage() {
    const config = getPageConfig('MEMORY_PAGE')
    const { setRightSidebarExpanded, setLeftSidebarExpanded, setLeftSidebarMinimized } = useLayout()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    usePageTitle()

    useEffect(() => {
        setRightSidebarExpanded(false)
        // Un-minimize as well: the chat page hides the left sidebar via the
        // minimized flag (width 0), which would otherwise persist here
        setLeftSidebarMinimized(false)
        setLeftSidebarExpanded(true)
    }, [setRightSidebarExpanded, setLeftSidebarExpanded, setLeftSidebarMinimized])

    return (
        <NotesProvider>
            <div className={styles.page}>
                <Navbar />
                <NotesHeader />
                <div className={styles.layout}>
                    {/* Saved notes mirror the chat page's conversation-history panel */}
                    {!isMobile && (
                        <ResizableSidebar
                            storageKey={SAVED_NOTES_WIDTH_STORAGE_KEY}
                            data-testid="saved-notes-sidebar"
                            handleTestId="saved-notes-resize-handle"
                        >
                            <SavedNotesWidget />
                        </ResizableSidebar>
                    )}
                    <CenterSection widgetIds={config.centerSection} />
                    <RightSidebar widgetIds={config.rightSidebar} />
                </div>
            </div>
        </NotesProvider>
    )
}
