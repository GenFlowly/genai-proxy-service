import React, { useState, useRef, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import LoginIcon from '../icons/LoginIcon'
import SettingsIcon from '../icons/SettingsIcon'
import styles from './Navbar.module.scss'

import logo from '../../assets/icons/logo.png'
import { UserAvatarButton } from '../common/UserAvatarButton/UserAvatarButton'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, logout, isAuthenticated, user, customerPicture, customerName } = useAuth()
    const [showDropdown, setShowDropdown] = useState<boolean>(false)
    const navigate = useNavigate()
    const menuRef = useRef<HTMLDivElement>(null)

    const displayPicture = customerPicture || user?.picture
    const displayName = customerName || user?.name || 'Account'

    const handleSettingsClick = () => {
        navigate('/settings')
        setShowDropdown(false)
    }

    const handleLogout = () => {
        logout({ returnTo: window.location.origin })
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setShowDropdown(false)
            }
        }

        if (showDropdown) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [showDropdown])

    return (
        <nav className={styles.navbar}>
            <div className={styles.container}>
                <div className={styles.leftControls}>
                    <Link to="/" className={styles.logoLink} title="Home">
                        <img src={logo} alt="Create a new prompt" className={styles.logoImage} />
                    </Link>
                </div>

                <div className={styles.centerControls}>
                    {/* Placeholder for future center controls if needed */}
                </div>

                <div className={styles.rightControls}>
                    <div className={styles.auth}>
                        {!isAuthenticated || !user ? (
                            <button
                                onClick={() => loginWithRedirect()}
                                className={styles.loginButton}
                            >
                                <LoginIcon />
                                <span>Login</span>
                            </button>
                        ) : (
                            <div className={styles.accountMenu} ref={menuRef}>
                                <UserAvatarButton
                                    onClick={() => setShowDropdown(!showDropdown)}
                                    displayName={displayName}
                                    displayPicture={displayPicture}
                                />

                                {showDropdown && (
                                    <div className={styles.dropdownMenu}>
                                        <div className={styles.dropdownHeader}>
                                            <p className={styles.dropdownLabel}>Hello {user?.name} 👋</p>
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
