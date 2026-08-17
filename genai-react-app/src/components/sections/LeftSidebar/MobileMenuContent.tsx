import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import { NavbarMenu } from '../../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../../common/ThemeToggle/ThemeToggle'
import { UserAvatarButton } from '@genflowly/component-library'
import { LoginIcon } from '@genflowly/component-library'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './MobileMenuContent.module.scss'

export const MobileMenuContent: React.FC = () => {
    const { t } = useTranslation()
    const { loginWithRedirect, isAuthenticated, isOnboarding, user, customerPicture, customerName } = useAuth()
    const { toggleLeftSidebar } = useLayout()
    const navigate = useNavigate()

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || t("layout.mobileMenu.account")

    const handleSettingsClick = () => {
        toggleLeftSidebar() // Close the menu before navigating
        React.startTransition(() => {
            navigate('/settings')
        })
    }

    const handleHistoryClick = () => {
        toggleLeftSidebar() // Close the menu before navigating
        React.startTransition(() => {
            navigate('/history') // On mobile, history opens as its own page
        })
    }

    const handleCloseMenu = () => {
        toggleLeftSidebar()
    }

    return (
        <div className={styles.mobileMenu}>
            <div className={styles.header}>
                <h2>{t("layout.mobileMenu.menu")}</h2>
                <button onClick={handleCloseMenu} className={styles.closeButton}>
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={20} />
                </button>
            </div>

            <div className={styles.content}>
                <button className={styles.historyButton} onClick={handleHistoryClick}>
                    <Icon src={ICONS.MENU} size={20} />
                    <span>{t("layout.mobileMenu.conversationHistory")}</span>
                </button>

                <div className={styles.navSection}>
                    <NavbarMenu />
                </div>
            </div>

            <div className={styles.footer}>
                <div className={styles.themeSection}>
                    <ThemeToggle />
                </div>
                <div className={styles.authSection}>
                    {!isAuthenticated && isOnboarding ? (
                        <div
                            className={styles.authPlaceholder}
                            aria-label={t("layout.mobileMenu.signingIn")}
                            data-testid="auth-onboarding-placeholder-mobile"
                        />
                    ) : !isAuthenticated || !user ? (
                        <button
                            onClick={() => loginWithRedirect()}
                            className={styles.loginButton}
                        >
                            <LoginIcon />
                            <span>{t("layout.mobileMenu.login")}</span>
                        </button>
                    ) : (
                        <button className={styles.accountButton} onClick={handleSettingsClick}>
                            <UserAvatarButton
                                displayName={displayName}
                                displayPicture={displayPicture}
                                className={styles.avatarButton}
                            />
                            <span className={styles.accountName}>{displayName}</span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
