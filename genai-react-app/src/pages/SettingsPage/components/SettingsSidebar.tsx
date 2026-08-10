import React from 'react'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '../../../components/common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './SettingsSidebar.module.scss'

import { useNavigate, useLocation } from 'react-router-dom'

export type SettingsTab = 'profile' | 'ai' | 'memory'

interface SettingsSidebarProps {
    // Renders the menu as a full page (mobile) instead of a side column
    fullPage?: boolean
}

export function SettingsSidebar({ fullPage = false }: SettingsSidebarProps = {}): React.ReactElement {
    const { logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()

    const activeTab = location.pathname.split('/').pop() || 'profile'

    return (
        <aside className={`${styles.sidebar} ${fullPage ? styles.fullPage : ''}`}>
            <div className={styles.header}>
                <h2>Settings</h2>
            </div>

            <nav className={styles.nav}>
                <button
                    className={`${styles.tabButton} ${activeTab === 'profile' ? styles.active : ''}`}
                    onClick={() => navigate('/settings/profile')}
                >
                    <Icon src={ICONS.USER_CIRCLE} size={20} className={styles.icon} />
                    <span>Profile</span>
                </button>
                <button
                    className={`${styles.tabButton} ${activeTab === 'ai' ? styles.active : ''}`}
                    onClick={() => navigate('/settings/ai')}
                >
                    <Icon src={ICONS.MODELS} size={20} className={styles.icon} />
                    <span>AI Settings</span>
                </button>
                <button
                    className={`${styles.tabButton} ${activeTab === 'memory' ? styles.active : ''}`}
                    onClick={() => navigate('/settings/memory')}
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
