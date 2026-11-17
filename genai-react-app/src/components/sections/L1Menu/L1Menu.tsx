import React from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Icon } from '@genflowly/component-library'
import { useAuth } from '../../../context/AuthContext'
import { useConversation } from '../../../context/ConversationContext'
import { useLayout } from '../../../context/LayoutContext'
import { APP_NAME } from '../../../constants/appName'
import { ICONS } from '../../../constants/icons'
import { MenuLocationState, OPEN_L2_MENU_STATE } from '../../../hooks/useAppMenu'
import { isNavItemActive, NAV_ITEMS } from '../../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../../common/ThemeToggle/ThemeToggle'
import logo from '../../../assets/icons/logo.png'
import styles from './L1Menu.module.scss'

// Instructions has no L2 Menu, so picking it goes straight to the screen
const ITEMS_WITHOUT_L2_MENU = ['instructions']

/**
 * The app's root on phones. Signed out it is the landing page: brand, headline,
 * login and theme. Signed in it lists where to go, and each pick leads to that
 * page's L2 Menu. There is no back or close: leaving means picking a destination.
 */
export const L1Menu: React.FC = () => {
    const { t } = useTranslation()
    const { loginWithRedirect, isAuthenticated, isOnboarding, user, customerPicture, customerName } = useAuth()
    const { conversationId } = useConversation()
    const { setLeftSidebarExpanded } = useLayout()
    const location = useLocation()

    const isOverlay = !!(location.state as MenuLocationState | null)?.appMenu
    const isSignedIn = isAuthenticated && !!user
    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || t('layout.mobileMenu.account')

    const brandLogo = <img src={logo} alt="" className={styles.logo} />

    const itemTarget = (item: typeof NAV_ITEMS[number]) => {
        // A bare /chat would reset the conversation that's open
        if (item.id === 'chat' && conversationId) return `/chat/${conversationId}`
        return item.path
    }

    return (
        <div
            className={styles.menu}
            data-testid="l1-menu"
            {...(isOverlay ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('layout.mobileMenu.menu') } : {})}
        >
            <header className={styles.header}>
                {brandLogo}
                {isSignedIn
                    ? <h1 className={styles.brandName}>{APP_NAME}</h1>
                    : <p className={styles.brandName}>{APP_NAME}</p>}
            </header>

            {isSignedIn ? (
                <nav className={styles.nav} aria-label={t('layout.mobileMenu.menu')}>
                    {NAV_ITEMS.map((item) => {
                        const isActive = isNavItemActive(location.pathname, item.path)
                        const hasL2Menu = !ITEMS_WITHOUT_L2_MENU.includes(item.id)
                        return (
                            <Link
                                key={item.id}
                                to={itemTarget(item)}
                                replace={isOverlay}
                                state={hasL2Menu ? OPEN_L2_MENU_STATE : undefined}
                                onClick={() => { if (!hasL2Menu) setLeftSidebarExpanded(false) }}
                                className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
                                aria-current={isActive ? 'page' : undefined}
                                data-testid={`l1-menu-item-${item.id}`}
                            >
                                {item.label}
                                {isActive && <span className={styles.activeDot} aria-hidden="true" />}
                            </Link>
                        )
                    })}
                </nav>
            ) : (
                <main className={styles.hero}>
                    <h1 className={styles.headline}>
                        <span>{t('layout.l1Menu.headlineOne')}</span>
                        <span>{t('layout.l1Menu.headlineTwo')}</span>
                        <span>{t('layout.l1Menu.headlineThree')}</span>
                    </h1>
                </main>
            )}

            <div className={styles.footer}>
                {isSignedIn ? (
                    <Link
                        to={location.pathname.startsWith('/settings') ? location.pathname : '/settings'}
                        replace={isOverlay}
                        state={OPEN_L2_MENU_STATE}
                        className={styles.accountButton}
                        data-testid="l1-menu-account"
                    >
                        {displayPicture ? (
                            <img src={displayPicture} alt="" className={styles.avatar} referrerPolicy="no-referrer" />
                        ) : (
                            <Icon src={ICONS.USER_CIRCLE} size={40} aria-hidden={true} />
                        )}
                        <span className={styles.accountName}>{displayName}</span>
                    </Link>
                ) : isOnboarding ? (
                    <div
                        className={styles.authPlaceholder}
                        aria-label={t('layout.mobileMenu.signingIn')}
                        data-testid="l1-menu-auth-placeholder"
                    />
                ) : (
                    <button
                        type="button"
                        className={styles.loginButton}
                        onClick={() => loginWithRedirect({
                            appState: { returnTo: '/chat', returnState: OPEN_L2_MENU_STATE },
                        })}
                        data-testid="l1-menu-login"
                    >
                        <Icon src={ICONS.LOGIN} size={20} aria-hidden={true} />
                        <span>{t('layout.mobileMenu.login')}</span>
                    </button>
                )}
                <ThemeToggle variant="surface" />
            </div>
        </div>
    )
}
