import React, { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../context/AuthContext'
import styles from './Navbar.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { ICONS } from '../../constants/icons'
import { Icon } from '@genflowly/component-library'

import logo from '../../assets/icons/logo.png'
import { UserAvatarButton } from '@genflowly/component-library'
import { NavbarMenu } from '../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../common/ThemeToggle/ThemeToggle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { MobileMenuContent } from '../sections/LeftSidebar/MobileMenuContent'

export default function Navbar(): React.ReactElement {
    const { t } = useTranslation()
    const { loginWithRedirect, isAuthenticated, isOnboarding, user, customerPicture, customerName } = useAuth()
    const { toggleLeftSidebar, toggleRightSidebar, isLeftSidebarExpanded } = useLayout()
    const navigate = useNavigate()
    const location = useLocation()
    const { width } = useWindowSize()
    const isMobile = width <= 768
    // The right sidebar (AI settings) only exists on the chat page
    const isChatPage = location.pathname === '/' || location.pathname.startsWith('/chat')

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || t("layout.navbar.account")

    // Pin the mobile menu directly below the navbar, whatever its rendered height is
    const navRef = useRef<HTMLElement>(null)
    const [menuTopOffset, setMenuTopOffset] = useState(0)
    const isMobileMenuOpen = isMobile && isLeftSidebarExpanded

    useLayoutEffect(() => {
        if (!isMobileMenuOpen) return
        const measure = () => {
            setMenuTopOffset(navRef.current ? Math.max(0, navRef.current.getBoundingClientRect().bottom) : 0)
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [isMobileMenuOpen])

    const handleSettingsClick = () => {
        React.startTransition(() => {
            navigate('/settings')
        })
    }


    return (
        <>
        <nav className={styles.navbar} ref={navRef}>
            <div className={styles.container}>
                <div className={styles.leftControls}>
                    <button onClick={toggleLeftSidebar} className={styles.mobileToggle} aria-label={t("layout.mobileMenu.menu")} data-testid="mobile-left-sidebar-toggle">
                        <Icon src={ICONS.MENU} size={24} />
                    </button>
                    <Link to="/" className={styles.logoLink} title={t("layout.navbar.home")} data-testid="navbar-logo-link">
                        <img src={logo} alt={t("layout.navbar.logoAlt")} className={styles.logoImage} />
                    </Link>
                </div>

                <div className={styles.centerControls}>
                    <NavbarMenu />
                </div>

                <div className={styles.rightControls}>
                    <ThemeToggle />
                    <div className={styles.auth}>
                        {!isAuthenticated && isOnboarding ? (
                            // First-time login: onboarding hasn't produced a
                            // customerId yet — don't flash the Login button
                            <div
                                className={styles.authPlaceholder}
                                aria-label={t("layout.navbar.signingIn")}
                                data-testid="auth-onboarding-placeholder"
                            />
                        ) : !isAuthenticated || !user ? (
                            <button
                                onClick={() => loginWithRedirect()}
                                className={styles.loginButton}
                                data-testid="login-button"
                            >
                                <Icon src={ICONS.LOGIN} size={20} aria-hidden={true} />
                                <span>{t("layout.navbar.login")}</span>
                            </button>
                        ) : (
                            <div className={styles.accountMenu}>
                                <UserAvatarButton
                                    onClick={handleSettingsClick}
                                    displayName={displayName}
                                    displayPicture={displayPicture}
                                    data-testid="user-avatar-button"
                                />
                            </div>
                        )}
                    </div>
                    {isChatPage && (
                        <button onClick={toggleRightSidebar} className={styles.mobileToggle} aria-label={t("layout.mobileFullPageModal.aiSettings")} data-testid="mobile-right-sidebar-toggle">
                            <Icon src={ICONS.MODELS} size={24} />
                        </button>
                    )}
                </div>
            </div>
        </nav>
        {isMobileMenuOpen && (
            <div className={styles.mobileMenuOverlay} style={{ top: menuTopOffset }}>
                <MobileMenuContent />
            </div>
        )}
        </>
    )
}
