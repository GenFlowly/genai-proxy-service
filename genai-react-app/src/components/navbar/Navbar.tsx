import React from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import LoginIcon from '../icons/LoginIcon'
import styles from './Navbar.module.scss'
import { useLayout } from '../../context/LayoutContext'
import { ICONS } from '../../constants/icons'
import { Icon } from '../common/Icon/Icon'

import logo from '../../assets/icons/logo.png'
import { UserAvatarButton } from '../common/UserAvatarButton/UserAvatarButton'
import { NavbarMenu } from '../widgets/NavbarMenuWidget/NavbarMenu'
import ThemeToggle from '../common/ThemeToggle/ThemeToggle'
import { useWindowSize } from '../../hooks/useWindowSize'
import { MobileMenuContent } from '../sections/LeftSidebar/MobileMenuContent'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, isAuthenticated, user, customerPicture, customerName } = useAuth()
    const { toggleLeftSidebar, toggleRightSidebar, isLeftSidebarExpanded } = useLayout()
    const navigate = useNavigate()
    const { width } = useWindowSize()
    const isMobile = width <= 768

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || 'Account'

    const handleSettingsClick = () => {
        React.startTransition(() => {
            navigate('/settings')
        })
    }

    return (
        <>
        <nav className={styles.navbar}>
            <div className={styles.container}>
                <div className={styles.leftControls}>
                    <button onClick={toggleLeftSidebar} className={styles.mobileToggle} data-testid="mobile-left-sidebar-toggle">
                        <Icon src={ICONS.MENU} size={24} />
                    </button>
                    <Link to="/" className={styles.logoLink} title="Home" data-testid="navbar-logo-link">
                        <img src={logo} alt="Create a new prompt" className={styles.logoImage} />
                    </Link>
                </div>

                <div className={styles.centerControls}>
                    <NavbarMenu />
                </div>

                <div className={styles.rightControls}>
                    <ThemeToggle />
                    <div className={styles.auth}>
                        {!isAuthenticated || !user ? (
                            <button
                                onClick={() => loginWithRedirect()}
                                className={styles.loginButton}
                                data-testid="login-button"
                            >
                                <LoginIcon />
                                <span>Login</span>
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
                    <button onClick={toggleRightSidebar} className={styles.mobileToggle} data-testid="mobile-right-sidebar-toggle">
                        <Icon src={ICONS.MODELS} size={24} />
                    </button>
                </div>
            </div>
        </nav>
        {isMobile && isLeftSidebarExpanded && (
            <div className={styles.mobileMenuOverlay}>
                <MobileMenuContent />
            </div>
        )}
        </>
    )
}
