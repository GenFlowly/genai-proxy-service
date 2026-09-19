import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../context/AuthContext'
import { NavbarMenu } from '../../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../../common/ThemeToggle/ThemeToggle'
import { UserAvatarButton } from '@genflowly/component-library'
import { Icon, ScrollArea } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './AppMenuContent.module.scss'

interface AppMenuContentProps {
    /** Called before navigating away (e.g. to close the menu overlay). */
    onNavigate?: () => void
}

/**
 * App-wide menu shown on mobile: exactly what the desktop navbar offers —
 * nav tabs, theme toggle and login/account. Page context (history, saved
 * notes) lives in the MobileMenu's context view, not here.
 */
export const AppMenuContent: React.FC<AppMenuContentProps> = ({ onNavigate }) => {
    const { t } = useTranslation()
    const { loginWithRedirect, isAuthenticated, isOnboarding, user, customerPicture, customerName } = useAuth()
    const navigate = useNavigate()

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || t("layout.mobileMenu.account")

    const handleSettingsClick = () => {
        onNavigate?.()
        React.startTransition(() => {
            navigate('/settings')
        })
    }

    return (
        <ScrollArea className={styles.appMenu} data-testid="app-menu-content">
            <div className={styles.navSection}>
                <NavbarMenu />
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
                            <Icon src={ICONS.LOGIN} size={20} aria-hidden={true} />
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
        </ScrollArea>
    )
}
