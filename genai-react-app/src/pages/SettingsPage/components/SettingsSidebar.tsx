import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './SettingsSidebar.module.scss'

import { useNavigate, useLocation } from 'react-router-dom'

export type SettingsTab = 'profile' | 'ai' | 'actions' | 'developer'

interface SettingsNavChild {
    key: string
    label: string
    path: string
}

interface SettingsNavItem {
    key: SettingsTab
    label: string
    icon: string
    path: string
    // Present → the item is a parent section: it expands to child links
    // instead of being a route of its own
    children?: SettingsNavChild[]
}

interface SettingsSidebarProps {
    // Renders the menu as a full page (mobile) instead of a side column
    fullPage?: boolean
}

export function SettingsSidebar({ fullPage = false }: SettingsSidebarProps = {}): React.ReactElement {
    const { t } = useTranslation()
    const { logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()

    const activeTab = location.pathname.split('/').pop() || 'profile'

    // Manual expand/collapse choices; when absent, a section is expanded
    // whenever the current route is inside it
    const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({})

    const navItems: SettingsNavItem[] = [
        {
            key: 'profile',
            label: t('settingsPage.settingsSidebar.profile'),
            icon: ICONS.USER_CIRCLE,
            path: '/settings/profile',
        },
        {
            key: 'ai',
            label: t('settingsPage.settingsSidebar.aiSettings'),
            icon: ICONS.MODELS,
            path: '/settings/ai',
            children: [
                {
                    key: 'model-keys',
                    label: t('settingsPage.settingsSidebar.aiModelKeys'),
                    path: '/settings/ai/model-keys',
                },
                {
                    key: 'embedding-keys',
                    label: t('settingsPage.settingsSidebar.aiEmbeddingKeys'),
                    path: '/settings/ai/embedding-keys',
                },
                {
                    key: 'vector-db',
                    label: t('settingsPage.settingsSidebar.aiVectorDb'),
                    path: '/settings/ai/vector-db',
                },
                {
                    key: 'defaults',
                    label: t('settingsPage.settingsSidebar.aiDefaults'),
                    path: '/settings/ai/defaults',
                },
            ],
        },
        {
            key: 'actions',
            label: t('settingsPage.settingsSidebar.actionAgents'),
            icon: ICONS.PROMPT_ICON,
            path: '/settings/actions',
        },
        {
            key: 'developer',
            label: t('settingsPage.settingsSidebar.developer'),
            icon: ICONS.EDIT,
            path: '/settings/developer',
        },
    ]

    const isInSection = (item: SettingsNavItem) => location.pathname.startsWith(item.path)

    const isExpanded = (item: SettingsNavItem) =>
        !!item.children && (expandedOverride[item.key] ?? isInSection(item))

    const handleParentClick = (item: SettingsNavItem) => {
        if (!item.children) return
        if (isExpanded(item)) {
            setExpandedOverride(prev => ({ ...prev, [item.key]: false }))
        } else {
            setExpandedOverride(prev => ({ ...prev, [item.key]: true }))
            // Opening a section from outside also takes you to its first page
            if (!isInSection(item)) navigate(item.children[0].path)
        }
    }

    return (
        <aside className={`${styles.sidebar} ${fullPage ? styles.fullPage : ''}`}>
            <div className={styles.header}>
                <h2>{t('settingsPage.settingsSidebar.title')}</h2>
            </div>

            <nav className={styles.nav}>
                {navItems.map(item => (
                    item.children ? (
                        <div key={item.key} className={styles.navGroup}>
                            <button
                                className={`${styles.tabButton} ${isInSection(item) ? styles.parentActive : ''}`}
                                onClick={() => handleParentClick(item)}
                                aria-expanded={isExpanded(item)}
                            >
                                <Icon src={item.icon} size={20} className={styles.icon} />
                                <span>{item.label}</span>
                                <Icon
                                    src={ICONS.ALT_ARROW_RIGHT}
                                    size={16}
                                    className={`${styles.chevron} ${isExpanded(item) ? styles.chevronOpen : ''}`}
                                />
                            </button>
                            {isExpanded(item) && (
                                <div className={styles.childNav}>
                                    {item.children.map(child => (
                                        <button
                                            key={child.key}
                                            className={`${styles.childButton} ${activeTab === child.key ? styles.active : ''}`}
                                            onClick={() => navigate(child.path)}
                                        >
                                            <span>{child.label}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <button
                            key={item.key}
                            className={`${styles.tabButton} ${activeTab === item.key ? styles.active : ''}`}
                            onClick={() => navigate(item.path)}
                        >
                            <Icon src={item.icon} size={20} className={styles.icon} />
                            <span>{item.label}</span>
                        </button>
                    )
                ))}
            </nav>

            <div className={styles.footer}>
                <button
                    className={styles.logoutButton}
                    onClick={() => logout({ returnTo: window.location.origin })}
                >
                    {t('settingsPage.settingsSidebar.logout')}
                </button>
            </div>
        </aside>
    )
}
