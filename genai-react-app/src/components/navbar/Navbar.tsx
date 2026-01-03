import React, { useState, useRef, useEffect } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useAI } from '../../context/AIContext'
import { ICONS } from '../../constants/icons'
import { InputSelectWithHint } from '../common/InputSelectWithHint/InputSelectWithHint'
import LoginIcon from '../icons/LoginIcon'
import SettingsIcon from '../icons/SettingsIcon'
import styles from './Navbar.module.scss'
import { useLayout } from '../../context/LayoutContext'

import { useConversation } from '../../context/ConversationContext'
import logo from '../../assets/icons/logo.png'
import { UserAvatarButton } from '../common/UserAvatarButton/UserAvatarButton'

export default function Navbar(): React.ReactElement {
    const { loginWithRedirect, logout, isAuthenticated, user, customerPicture, customerName } = useAuth()
    const { customerInstructions } = useAI()
    const { isLeftSidebarExpanded, isRightSidebarExpanded, isInstructionWidgetExpanded, setInstructionWidgetExpanded } = useLayout()
    const { setSystemPrompt, selectedInstructionId, setSelectedInstructionId } = useConversation()
    const [showDropdown, setShowDropdown] = useState<boolean>(false)
    const navigate = useNavigate()
    const location = useLocation()
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

    // Filter instructions to show only the latest version for each ID
    const uniqueInstructions = React.useMemo(() => {
        if (!customerInstructions) return []
        const map = new Map<string, typeof customerInstructions[0]>()
        customerInstructions.forEach(inst => {
            const existing = map.get(inst.id)
            if (!existing || inst.version > existing.version) {
                map.set(inst.id, inst)
            }
        })
        return Array.from(map.values())
    }, [customerInstructions])

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
                            value={(() => {
                                // If we have a selected ID, show it.
                                if (selectedInstructionId) {
                                    return selectedInstructionId
                                }
                                // If no ID but expanded (and implies creating), show CTA value.
                                return (isInstructionWidgetExpanded) ? 'CTA_ACTION' : ''
                            })()}
                            onChange={(val) => {
                                // Find by ID in the UNIQUE list to ensure we get the latest version
                                const selectedInstruction = uniqueInstructions.find(i => i.id === val)
                                if (selectedInstruction) {
                                    setSelectedInstructionId(selectedInstruction.id)
                                    setSystemPrompt(selectedInstruction.instruction)
                                } else {
                                    setSelectedInstructionId(null)
                                }
                            }}
                            options={(() => {
                                const filteredOptions = uniqueInstructions.map(item => ({
                                    label: item.name || item.instruction.substring(0, 50),
                                    value: item.id, // Use ID as value!
                                }));

                                const ctaOption = {
                                    label: 'Create Instructions',
                                    value: 'CTA_ACTION',
                                    isCta: true,
                                    ctaAction: () => {
                                        setSelectedInstructionId(null)
                                        setSystemPrompt('')
                                        setInstructionWidgetExpanded(true)
                                    },
                                    style: {
                                        borderTop: '1px solid #e5e7eb',
                                        marginTop: '4px',
                                        paddingTop: '8px',
                                        color: '#2563eb',
                                        fontWeight: 500
                                    }
                                }

                                return [...filteredOptions, ctaOption]
                            })()}
                        />
                    )}
                </div>

                <div className={`${styles.rightControls} ${!isRightSidebarExpanded ? styles.collapsed : ''}`}>
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
