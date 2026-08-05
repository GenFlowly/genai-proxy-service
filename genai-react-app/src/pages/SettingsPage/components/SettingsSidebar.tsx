import React from 'react'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '../../../components/common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './SettingsSidebar.module.scss'

export type SettingsTab = 'profile' | 'ai' | 'memory'

interface SettingsSidebarProps {
    activeTab: SettingsTab
    onTabChange: (tab: SettingsTab) => void
}

export function SettingsSidebar({ activeTab, onTabChange }: SettingsSidebarProps): React.ReactElement {
    const { logout } = useAuth()

    return (
        <aside className={styles.sidebar}>
            <div className={styles.header}>
                <h2>Settings</h2>
            </div>
            
            <nav className={styles.nav}>
                <button
                    className={`${styles.tabButton} ${activeTab === 'profile' ? styles.active : ''}`}
                    onClick={() => onTabChange('profile')}
                >
                    <Icon src={ICONS.USER_CIRCLE} size={20} className={styles.icon} />
                    <span>Profile</span>
                </button>
                <button
                    className={`${styles.tabButton} ${activeTab === 'ai' ? styles.active : ''}`}
                    onClick={() => onTabChange('ai')}
                >
                    <Icon src={ICONS.MODELS} size={20} className={styles.icon} />
                    <span>AI Settings</span>
                </button>
                <button
                    className={`${styles.tabButton} ${activeTab === 'memory' ? styles.active : ''}`}
                    onClick={() => onTabChange('memory')}
                >
                    <Icon src={ICONS.TOKENS} size={20} className={styles.icon} />
                    <span>Memory Settings</span>
                </button>
            </nav>

            <div className={styles.footer}>
                <button
                    className={styles.logoutButton}
                    onClick={() => logout({ returnTo: window.location.origin })}
                >
                    Logout
                </button>
            </div>
        </aside>
    )
}
