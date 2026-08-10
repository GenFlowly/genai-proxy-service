import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useLayout } from '../../../context/LayoutContext'
import { NavbarMenu } from '../../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../../common/ThemeToggle/ThemeToggle'
import { UserAvatarButton } from '../../common/UserAvatarButton/UserAvatarButton'
import LoginIcon from '../../icons/LoginIcon'
import { Icon } from '../../common/Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './MobileMenuContent.module.scss'

export const MobileMenuContent: React.FC = () => {
    const { loginWithRedirect, isAuthenticated, user, customerPicture, customerName } = useAuth()
    const { setHistoryWidgetExpanded, toggleLeftSidebar } = useLayout()
    const navigate = useNavigate()

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || 'Account'

    const handleSettingsClick = () => {
        toggleLeftSidebar() // Close the menu before navigating
        React.startTransition(() => {
            navigate('/settings')
        })
    }

    const handleHistoryClick = () => {
        setHistoryWidgetExpanded(true)
        toggleLeftSidebar() // Close the left menu so history can take over
    }

    const handleCloseMenu = () => {
        toggleLeftSidebar()
    }

    return (
        <div className={styles.mobileMenu}>
            <div className={styles.header}>
                <h2>Menu</h2>
                <button onClick={handleCloseMenu} className={styles.closeButton}>
                    <Icon src={ICONS.ALT_ARROW_LEFT} size={20} />
                </button>
            </div>

            <div className={styles.content}>
                <button className={styles.historyButton} onClick={handleHistoryClick}>
                    <Icon src={ICONS.MENU} size={20} />
                    <span>Conversation History</span>
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
                    {!isAuthenticated || !user ? (
                        <button
                            onClick={() => loginWithRedirect()}
                            className={styles.loginButton}
                        >
                            <LoginIcon />
                            <span>Login</span>
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
