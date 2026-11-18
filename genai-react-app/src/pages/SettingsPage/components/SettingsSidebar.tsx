import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useLocation } from 'react-router'
import { useAuth } from '../../../context/AuthContext'
import { Icon, MenuSearchField, PillButton, SidebarWidget } from '@genflowly/component-library'
import type { TreeMenuItem } from '@genflowly/component-library'
import MobileMenuBody from '../../../components/widgets/MobileMenuBody/MobileMenuBody'
import { ICONS } from '../../../constants/icons'
import { SETTINGS_SECTIONS } from '../settingsNav'
import styles from './SettingsSidebar.module.scss'

interface SettingsSidebarProps {
    /** Called after navigating to a page — closes the mobile menu overlay. */
    onNavigate?: () => void
    /** The full-screen phone menu: cards, sections opening in place, and the footer card. */
    menu?: boolean
}

/**
 * The Settings menu: grouped sections with search. On desktop its footer
 * holds only Logout; the phone menu adds a card with Support and the privacy
 * policy above Logout.
 */
export function SettingsSidebar({ onNavigate, menu = false }: SettingsSidebarProps = {}): React.ReactElement {
    const { t } = useTranslation()
    const { logout } = useAuth()
    const navigate = useNavigate()
    const location = useLocation()
    const [query, setQuery] = useState('')

    const items: TreeMenuItem[] = useMemo(() => SETTINGS_SECTIONS.map(section => ({
        key: section.key,
        label: t(section.labelKey),
        icon: section.icon,
        path: section.path,
        children: section.pages?.map(page => ({ key: page.key, label: t(page.labelKey), path: page.path })),
    })), [t])

    const supportHit = { key: 'support', label: t('settingsPage.nav.support'), icon: ICONS.CHAT_BUBBLE, path: '/support' }

    const go = (path: string) => {
        navigate(path)
        setQuery('')
        onNavigate?.()
    }

    const tree = {
        items,
        activePath: location.pathname,
        onNavigate: go,
        query,
        extraSearchHits: menu ? [supportHit] : [],
        noResultsLabel: t('layout.mobileMenu.noSearchResults'),
        'aria-label': t('settingsPage.nav.title'),
        testIdPrefix: 'settings',
    }

    const logOut = () => logout({ returnTo: window.location.origin })

    if (menu) {
        return (
            <MobileMenuBody
                searchValue={query}
                onSearchChange={setQuery}
                searchPlaceholder={t('layout.mobileMenu.searchSettings')}
            >
                <SidebarWidget variant="menu" touch title={t('settingsPage.nav.title')} menu={tree} />
                {!query.trim() && (
                    <SidebarWidget className={styles.menuLinkCard}>
                        <button className={styles.menuLink} onClick={() => go('/support')} data-testid="settings-menu-support">
                            <span className={styles.menuLinkLabel}>{t('settingsPage.nav.support')}</span>
                            <Icon src={ICONS.ALT_ARROW_RIGHT} size={16} className={styles.menuLinkChevron} />
                        </button>
                        <button className={styles.menuLink} onClick={() => go('/privacy-policy')} data-testid="settings-menu-privacy-policy">
                            <span className={styles.menuLinkLabel}>{t('settingsPage.nav.privacyPolicy')}</span>
                            <Icon src={ICONS.ALT_ARROW_RIGHT} size={16} className={styles.menuLinkChevron} />
                        </button>
                        <div className={styles.menuDivider} />
                        <button className={styles.menuLogout} onClick={logOut} data-testid="settings-menu-logout">
                            <Icon src={ICONS.LOGOUT} size={18} />
                            <span>{t('settingsPage.nav.logout')}</span>
                        </button>
                    </SidebarWidget>
                )}
            </MobileMenuBody>
        )
    }

    return (
        <SidebarWidget
            variant="menu"
            fill
            title={t('settingsPage.nav.title')}
            menu={tree}
            search={
                <MenuSearchField
                    value={query}
                    onChange={setQuery}
                    placeholder={t('settingsPage.nav.search')}
                    clearLabel={t('layout.mobileMenu.clearSearch')}
                    variant="sidebar"
                    data-testid="settings-sidebar-search"
                />
            }
            footer={
                <PillButton
                    label={t('settingsPage.nav.logout')}
                    icon={ICONS.LOGOUT}
                    variant="danger"
                    className={styles.logoutButton}
                    onClick={logOut}
                    data-testid="settings-sidebar-logout"
                />
            }
        />
    )
}
