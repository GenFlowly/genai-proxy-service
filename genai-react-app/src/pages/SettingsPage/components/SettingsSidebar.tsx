import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { Icon, PillButton } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './SettingsSidebar.module.scss'

import { useNavigate, useLocation } from 'react-router-dom'

export type SettingsTab = 'profile' | 'ai' | 'usage' | 'defaults' | 'tools' | 'connectors' | 'developer'

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
                    key: 'llm-keys',
                    label: t('settingsPage.settingsSidebar.aiModelKeys'),
                    path: '/settings/ai/llm-keys',
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
            ],
        },
        {
            key: 'usage',
            label: t('settingsPage.settingsSidebar.usage'),
            icon: ICONS.TOKENS,
            path: '/settings/usage',
            children: [
                {
                    key: 'llm-models',
                    label: t('settingsPage.settingsSidebar.usageLlmModels'),
                    path: '/settings/usage/llm-models',
                },
                {
                    key: 'embedding-models',
                    label: t('settingsPage.settingsSidebar.usageEmbeddingModels'),
                    path: '/settings/usage/embedding-models',
                },
                {
                    key: 'vector-db',
                    label: t('settingsPage.settingsSidebar.usageVectorDb'),
                    path: '/settings/usage/vector-db',
                },
                {
                    key: 'web-search',
                    label: t('settingsPage.settingsSidebar.usageWebSearch'),
                    path: '/settings/usage/web-search',
                },
            ],
        },
        {
            key: 'defaults',
            label: t('settingsPage.settingsSidebar.defaults'),
            icon: ICONS.PROMPT_ICON,
            path: '/settings/defaults',
        },
        {
            key: 'tools',
            label: t('settingsPage.settingsSidebar.tools'),
            icon: ICONS.STEPS,
            path: '/settings/tools',
        },
        {
            key: 'connectors',
            label: t('settingsPage.settingsSidebar.connectors'),
            icon: ICONS.LINK,
            path: '/settings/connectors',
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
            // Desktop: opening a section from outside also takes you to its first
            // page — the sidebar stays visible alongside the content. On the mobile
            // full-page menu we must NOT navigate: this menu is its own page, so
            // routing to a child would leave the menu before the submenu can show.
            // There, tapping the parent just expands it; the user then taps a child.
            if (!fullPage && !isInSection(item)) navigate(item.children[0].path)
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
                                            // Scoped to this parent section: child keys are only unique
                                            // within their own parent (e.g. 'vector-db' exists under both
                                            // 'ai' and 'usage'), so matching activeTab alone would
                                            // cross-highlight siblings of the same name in another section.
                                            className={`${styles.childButton} ${isInSection(item) && activeTab === child.key ? styles.active : ''}`}
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
                <PillButton
                    label={t('settingsPage.settingsSidebar.logout')}
                    icon={ICONS.LOGOUT}
                    variant="danger"
                    className={styles.logoutButton}
                    onClick={() => logout({ returnTo: window.location.origin })}
                />
            </div>
        </aside>
    )
}
