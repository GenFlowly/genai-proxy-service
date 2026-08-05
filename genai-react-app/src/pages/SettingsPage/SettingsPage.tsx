import React, { useState } from 'react'
import Navbar from '../../components/navbar/Navbar'
import styles from './SettingsPage.module.scss'
import { SettingsSidebar, SettingsTab } from './components/SettingsSidebar'
import { ProfileSettings } from './components/ProfileSettings'
import { AISettings } from './components/AISettings'
import { MemorySettings } from './components/MemorySettings'
import { usePageTitle } from '../../hooks/usePageTitle'

export default function SettingsPage(): React.ReactElement {
    usePageTitle()
    const [activeTab, setActiveTab] = useState<SettingsTab>('profile')

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.layout}>
                <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} />
                <div className={styles.content}>
                    <div className={styles.contentInner}>
                        {activeTab === 'profile' && <ProfileSettings />}
                        {activeTab === 'ai' && <AISettings />}
                        {activeTab === 'memory' && <MemorySettings />}
                    </div>
                </div>
            </div>
        </div>
    )
}