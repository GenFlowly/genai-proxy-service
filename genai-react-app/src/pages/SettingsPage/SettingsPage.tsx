import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar } from './components/SettingsSidebar'
import SettingsMenuPage from './SettingsMenuPage'
import { ProfileSettings } from './components/ProfileSettings'
import { AISettings } from './components/AISettings'
import { MemorySettings } from './components/MemorySettings'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { useLayout } from '../../context/LayoutContext'
import Breadcrumbs, { BreadcrumbItem } from '../../components/common/Breadcrumbs/Breadcrumbs'

import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'

// Labels for the section breadcrumb, keyed by the route segment
const SECTION_LABELS: Record<string, string> = {
    profile: 'Profile',
    ai: 'AI Settings',
    memory: 'Memory Settings',
}

export default function SettingsPage(): React.ReactElement {
    usePageTitle()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    const navigate = useNavigate()
    const location = useLocation()
    const { setLeftSidebarExpanded } = useLayout()

    // Breadcrumbs (mobile only): Menu > Settings [> Section]
    const section = SECTION_LABELS[location.pathname.split('/').pop() || '']
    const breadcrumbItems: BreadcrumbItem[] = [
        // "Menu" reopens the mobile menu overlay
        { label: 'Menu', onClick: () => setLeftSidebarExpanded(true) },
        { label: 'Settings', onClick: () => navigate('/settings') },
        ...(section ? [{ label: section, onClick: () => navigate(location.pathname) }] : []),
    ]

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.layout}>
                {/* On mobile the menu is its own page (/settings); the sidebar column is desktop-only */}
                {!isMobile && <SettingsSidebar />}
                <div className={styles.content}>
                    <div className={styles.contentInner}>
                        {isMobile && <Breadcrumbs items={breadcrumbItems} />}
                        <Routes>
                            {/* Mobile: /settings shows the menu as a full page.
                                Desktop: /settings redirects to the first section. */}
                            <Route path="/" element={isMobile ? <SettingsMenuPage /> : <Navigate to="profile" replace />} />
                            <Route path="profile" element={<ProfileSettings />} />
                            <Route path="ai" element={<AISettings />} />
                            <Route path="memory" element={<MemorySettings />} />
                        </Routes>
                    </div>
                </div>
            </div>
        </div>
    )
}