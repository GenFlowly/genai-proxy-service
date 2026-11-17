import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { Icon, PillButton, ScrollArea, SidebarWidget } from '@genflowly/component-library'
import MobileMenuBody from '../../../components/widgets/MobileMenuBody/MobileMenuBody'
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
    /** Called after navigating to a section — closes the mobile menu overlay. */
    onNavigate?: () => void
    // The full-screen mobile menu: cards, sub-pages opening in place, and a
    // search that filters the sections
    menu?: boolean
}

export function SettingsSidebar({ onNavigate, menu = false }: SettingsSidebarProps = {}): React.ReactElement {
    const { t } = useTranslation()
    const { logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()

    const activeTab = location.pathname.split('/').pop() || 'profile'

    // Manual expand/collapse choices; when absent, a section is expanded
    // whenever the current route is inside it
    const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({})
    const [query, setQuery] = useState('')

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
            // Opening a section from outside also takes you to its first page.
            // On the mobile hamburger menu this also closes the overlay via
            // onNavigate; reopening it shows the section already expanded
            // (isExpanded defaults to isInSection) so a different child is one
            // more tap away.
            if (!menu && !isInSection(item)) {
                navigate(item.children[0].path)
                onNavigate?.()
            }
        }
    }

    const iconSize = menu ? 18 : 20

    const normalizedQuery = query.trim().toLowerCase()
    const matches = (label: string) => label.toLowerCase().includes(normalizedQuery)
    // Support lives outside Settings, at the public /support page.
    const supportLink = { key: 'support', label: t('settingsPage.settingsSidebar.support'), icon: ICONS.CHAT_BUBBLE, path: '/support' }

    const searchHits = [
        ...navItems.flatMap(item =>
            item.children
                ? item.children
                    .filter(child => matches(child.label) || matches(item.label))
                    .map(child => ({ key: `${item.key}-${child.key}`, label: child.label, icon: item.icon, path: child.path }))
                : matches(item.label)
                    ? [{ key: item.key as string, label: item.label, icon: item.icon, path: item.path }]
                    : []
        ),
        ...(matches(supportLink.label) ? [supportLink] : []),
    ]

    const nav = (
            <nav className={`${styles.nav} ${menu ? styles.menuNav : ''}`}>
                {navItems.map(item => (
                    item.children ? (
                        <div key={item.key} className={styles.navGroup}>
                            <button
                                className={`${styles.tabButton} ${isInSection(item) ? styles.parentActive : ''}`}
                                onClick={() => handleParentClick(item)}
                                aria-expanded={isExpanded(item)}
                            >
                                <Icon src={item.icon} size={iconSize} className={styles.icon} />
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
                                            onClick={() => { navigate(child.path); onNavigate?.() }}
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
                            onClick={() => { navigate(item.path); onNavigate?.() }}
                        >
                            <Icon src={item.icon} size={iconSize} className={styles.icon} />
                            <span>{item.label}</span>
                        </button>
                    )
                ))}
            </nav>
    )

    if (menu) {
        return (
            <MobileMenuBody
                searchValue={query}
                onSearchChange={setQuery}
                searchPlaceholder={t('layout.mobileMenu.searchSettings')}
            >
                <SidebarWidget className={styles.menuCard}>
                    <h2 className={styles.menuHeader}>{t('settingsPage.settingsSidebar.title')}</h2>
                    <ScrollArea className={styles.menuScroll}>
                        {normalizedQuery ? (
                            searchHits.length > 0 ? (
                                <nav className={`${styles.nav} ${styles.menuNav}`}>
                                    {searchHits.map(hit => (
                                        <button
                                            key={hit.key}
                                            className={styles.tabButton}
                                            onClick={() => { navigate(hit.path); onNavigate?.() }}
                                            data-testid={`settings-search-hit-${hit.key}`}
                                        >
                                            <Icon src={hit.icon} size={iconSize} className={styles.icon} />
                                            <span>{hit.label}</span>
                                        </button>
                                    ))}
                                </nav>
                            ) : (
                                <p className={styles.menuEmpty}>{t('layout.mobileMenu.noSearchResults')}</p>
                            )
                        ) : nav}
                    </ScrollArea>
                </SidebarWidget>
                <SidebarWidget className={styles.menuLinkCard}>
                    <button
                        className={styles.menuLink}
                        onClick={() => { navigate(supportLink.path); onNavigate?.() }}
                        data-testid="settings-menu-support"
                    >
                        <Icon src={supportLink.icon} size={iconSize} className={styles.icon} />
                        <span>{supportLink.label}</span>
                    </button>
                    <button
                        className={styles.menuLink}
                        onClick={() => { navigate('/privacy-policy'); onNavigate?.() }}
                        data-testid="settings-menu-privacy-policy"
                    >
                        <Icon src={ICONS.DOCUMENT_TEXT} size={iconSize} className={styles.icon} />
                        <span>{t('settingsPage.settingsSidebar.privacyPolicy')}</span>
                    </button>
                </SidebarWidget>
                <SidebarWidget className={styles.menuLogoutCard}>
                    <button
                        className={styles.menuLogout}
                        onClick={() => logout({ returnTo: window.location.origin })}
                        data-testid="settings-menu-logout"
                    >
                        <Icon src={ICONS.LOGOUT} size={iconSize} />
                        <span>{t('settingsPage.settingsSidebar.logout')}</span>
                    </button>
                </SidebarWidget>
            </MobileMenuBody>
        )
    }

    return (
        <aside className={styles.sidebar}>
            <div className={styles.header}>
                <h2>{t('settingsPage.settingsSidebar.title')}</h2>
            </div>

            {nav}

            <div className={styles.footer}>
                <button
                    className={`${styles.tabButton} ${styles.footerLink}`}
                    onClick={() => { navigate(supportLink.path); onNavigate?.() }}
                    data-testid="settings-sidebar-support"
                >
                    <Icon src={supportLink.icon} size={iconSize} className={styles.icon} />
                    <span>{supportLink.label}</span>
                </button>
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
