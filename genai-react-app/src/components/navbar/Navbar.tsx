import React, { useState, useRef, useEffect } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { Icon } from '../common/Icon/Icon'
import { ICONS } from '../../constants/icons'
import { InputSelectWithHint } from '../common/InputSelectWithHint/InputSelectWithHint'
import LoginIcon from '../icons/LoginIcon'
import SettingsIcon from '../icons/SettingsIcon'
import styles from './Navbar.module.scss'
import { useLayout } from '../../context/LayoutContext'

import { useConversation } from '../../context/ConversationContext'
import logo from '../../assets/icons/logo.png'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, logout, isAuthenticated, user } = useAuth()
    const { isLeftSidebarExpanded, isRightSidebarExpanded, isInstructionWidgetExpanded, setInstructionWidgetExpanded } = useLayout()
    const { systemPrompt, setSystemPrompt } = useConversation()
    const [showDropdown, setShowDropdown] = useState<boolean>(false)
    const navigate = useNavigate()
    const location = useLocation()
    const menuRef = useRef<HTMLDivElement>(null)

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
                <div className={`${styles.leftControls} ${!isLeftSidebarExpanded ? styles.collapsed : ''}`}>
                    <Link to="/" className={styles.logoLink} title="Home">
                        <img src={logo} alt="Create a new prompt" className={styles.logoImage} />
                    </Link>
                </div>

                <div className={styles.centerControls}>
                    {location.pathname.startsWith('/chat') && (
                        <InputSelectWithHint
                            hint="Instructions for AI"
                            icon={ICONS.USER_ROLE}
                            placeholder="Select a persona"
                            className={styles.roleInput}
                            value={isInstructionWidgetExpanded ? 'CTA_ACTION' : systemPrompt}
                            onChange={(val) => {
                                setSystemPrompt(val)
                                setInstructionWidgetExpanded(false)
                            }}
                            options={(() => {
                                const predefinedOptions = [
                                    {
                                        label: 'You are a helpful assistant.',
                                        value: 'You are a helpful assistant.',
                                        isCta: false,
                                    }
                                ]

                                const ctaOption = {
                                    label: 'Create Instructions',
                                    value: 'CTA_ACTION',
                                    isCta: true,
                                    ctaAction: () => setInstructionWidgetExpanded(true)
                                }

                                const showDynamicOption = systemPrompt && !predefinedOptions.some(opt => opt.value === systemPrompt)

                                return [
                                    ...(showDynamicOption ? [{
                                        label: systemPrompt.length > 50 ? `${systemPrompt.substring(0, 50)}...` : systemPrompt,
                                        value: systemPrompt
                                    }] : []),
                                    ...predefinedOptions,
                                    ctaOption
                                ]
                            })()}
                        />
                    )}
                </div>

                <div className={`${styles.rightControls} ${!isRightSidebarExpanded ? styles.collapsed : ''}`}>
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
                            <div className={styles.accountMenu} ref={menuRef}>
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
