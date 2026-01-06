import React from 'react'
import { useTheme } from '../../../context/ThemeContext'
import styles from './ThemeToggle.module.scss'

interface ThemeToggleProps {
    className?: string
    'data-testid'?: string
}

export default function ThemeToggle({ className = '', 'data-testid': testId }: ThemeToggleProps = {}) {
    const { theme, toggleTheme } = useTheme()

    return (
        <button
            className={`${styles.themeToggle} ${className}`}
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            data-testid={testId || 'theme-toggle'}
        >
            {theme === 'light' ? '🌙' : '☀️'}
        </button>
    )
}
