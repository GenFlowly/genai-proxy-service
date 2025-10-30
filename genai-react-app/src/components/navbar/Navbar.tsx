import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLayout } from '../../context/LayoutContext'
import UserIcon from '../icons/UserIcon'
import LoginIcon from '../icons/LoginIcon'
import SettingsIcon from '../icons/SettingsIcon'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import styles from './Navbar.module.scss'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, logout, isAuthenticated, user } = useAuth()
    const { isLeftVisible, isRightVisible, toggleLeftSidebar, toggleRightSidebar } = useLayout()
    const [showDropdown, setShowDropdown] = useState<boolean>(false)
    const navigate = useNavigate()

    const handleSettingsClick = () => {
        navigate('/settings')
        setShowDropdown(false)
    }

    const handleLogout = () => {
        logout({ returnTo: window.location.origin })
    }

    return (
        <nav className={styles.navbar}>
            <div className={styles.container}>
                <div className={styles.leftControls}>
                    <button
                        onClick={toggleLeftSidebar}
                        className={styles.toggleButton}
                        title={isLeftVisible ? 'Collapse Left Sidebar' : 'Expand Left Sidebar'}
                    >
                        {isLeftVisible ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
                    </button>

                    <Link to="/" className={styles.logo}>
                        MyApp
                    </Link>
                </div>

                <div className={styles.rightControls}>
                    <button
                        onClick={toggleRightSidebar}
                        className={styles.toggleButton}
                        title={isRightVisible ? 'Collapse Right Sidebar' : 'Expand Right Sidebar'}
                    >
                        {isRightVisible ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
                    </button>

                    <div className={styles.auth}>
                        {!isAuthenticated ? (
                            <button
                                onClick={() => loginWithRedirect()}
                                className={styles.loginButton}
                            >
                                <LoginIcon />
                                <span>Login</span>
                            </button>
                        ) : (
                            <div className={styles.accountMenu}>
                                <button
                                    onClick={() => setShowDropdown(!showDropdown)}
                                    className={styles.accountButton}
                                >
                                    <UserIcon />
                                    <span>Account</span>
                                </button>

                                {showDropdown && (
                                    <div className={styles.dropdownMenu}>
                                        <div className={styles.dropdownHeader}>
                                            <p className={styles.dropdownLabel}>Signed in as</p>
                                            <p className={styles.dropdownEmail}>{user?.email}</p>
                                        </div>
                                        <button
                                            onClick={handleSettingsClick}
                                            className={styles.dropdownItem}
                                        >
                                            <SettingsIcon />
                                            <span>Settings</span>
                                        </button>
                                        <button
                                            onClick={handleLogout}
                                            className={styles.dropdownItem}
                                        >
                                            Logout
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </nav>
    )
}
