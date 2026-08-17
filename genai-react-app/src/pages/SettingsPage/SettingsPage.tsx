import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar } from './components/SettingsSidebar'
import SettingsMenuPage from './SettingsMenuPage'
import { ProfileSettings } from './components/ProfileSettings'
import { AISettings } from './components/AISettings'
import { MemorySettings } from './components/MemorySettings'
import { DeveloperSettings } from './components/DeveloperSettings'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { useLayout } from '../../context/LayoutContext'
import { Breadcrumbs, BreadcrumbItem } from '@genflowly/component-library'

import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

// Translation keys for the section breadcrumb, keyed by the route segment
const SECTION_LABEL_KEYS: Record<string, string> = {
    profile: 'settingsPage.settingsPage.sectionProfile',
    ai: 'settingsPage.settingsPage.sectionAi',
    memory: 'settingsPage.settingsPage.sectionMemory',
    developer: 'settingsPage.settingsPage.sectionDeveloper',
}

export default function SettingsPage(): React.ReactElement {
    const { t } = useTranslation()
    usePageTitle()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    const navigate = useNavigate()
    const location = useLocation()
    const { setLeftSidebarExpanded } = useLayout()

    // Breadcrumbs (mobile only): Menu > Settings [> Section]
    const sectionKey = SECTION_LABEL_KEYS[location.pathname.split('/').pop() || '']
    const breadcrumbItems: BreadcrumbItem[] = [
        // "Menu" reopens the mobile menu overlay
        { label: t('settingsPage.settingsPage.breadcrumbMenu'), onClick: () => setLeftSidebarExpanded(true) },
        { label: t('settingsPage.settingsPage.breadcrumbSettings'), onClick: () => navigate('/settings') },
        ...(sectionKey ? [{ label: t(sectionKey), onClick: () => navigate(location.pathname) }] : []),
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
                            <Route path="developer" element={<DeveloperSettings />} />
                        </Routes>
                    </div>
                </div>
            </div>
        </div>
    )
}