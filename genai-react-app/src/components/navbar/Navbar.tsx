import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { Icon } from '../common/Icon/Icon'
import { ICONS } from '../../constants/icons'
import { InputTextWithHint } from '../common/InputTextWithHint/InputTextWithHint'
import LoginIcon from '../icons/LoginIcon'
import SettingsIcon from '../icons/SettingsIcon'
import styles from './Navbar.module.scss'

import logo from '../../assets/icons/logo.png'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, logout, isAuthenticated, user } = useAuth()
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
                    <Link to="/" className={styles.logoLink} title="Home">
                        <img src={logo} alt="MyApp Logo" className={styles.logoImage} />
                    </Link>
                </div>

                <div className={styles.centerControls}>
                    <InputTextWithHint
                        hint="User Role"
                        icon={ICONS.USER_ROLE}
                        placeholder="Type a role..."
                        className={styles.roleInput}
                    />
                </div>

                <div className={styles.rightControls}>
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
                                    <Icon src={ICONS.USER_CIRCLE} size={20} />
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
