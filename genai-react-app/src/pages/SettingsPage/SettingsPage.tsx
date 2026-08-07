import React from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar } from './components/SettingsSidebar'
import { ProfileSettings } from './components/ProfileSettings'
import { AISettings } from './components/AISettings'
import { MemorySettings } from './components/MemorySettings'
import { usePageTitle } from '../../hooks/usePageTitle'

import { Routes, Route, Navigate } from 'react-router-dom'

export default function SettingsPage(): React.ReactElement {
    usePageTitle()

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.layout}>
                <SettingsSidebar />
                <div className={styles.content}>
                    <div className={styles.contentInner}>
                        <Routes>
                            <Route path="/" element={<Navigate to="profile" replace />} />
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