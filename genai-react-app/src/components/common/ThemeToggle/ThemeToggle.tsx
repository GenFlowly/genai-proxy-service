import React from 'react'
import { useTheme } from '../../../context/ThemeContext'
import styles from './ThemeToggle.module.scss'

interface ThemeToggleProps {
    className?: string
    'data-testid'?: string
}

export default function ThemeToggle({ className = '', 'data-testid': testId }: ThemeToggleProps = {}) {
    const { themeMode, setThemeMode } = useTheme()

    const options = [
        { id: 'light', icon: '☀️', label: 'Light Theme' },
        { id: 'system', icon: '💻', label: 'System Theme' },
        { id: 'dark', icon: '🌙', label: 'Dark Theme' }
    ] as const;

    return (
        <div 
            className={`${styles.themeToggleContainer} ${className}`} 
            data-testid={testId || 'theme-toggle'}
            aria-label="Theme selection"
        >
            <div 
                className={styles.slider} 
                data-active={themeMode}
            />
            {options.map((opt) => (
                <button
                    key={opt.id}
                    className={`${styles.toggleOption} ${themeMode === opt.id ? styles.active : ''}`}
                    onClick={() => setThemeMode(opt.id)}
                    title={opt.label}
                    aria-label={opt.label}
                    data-testid={`theme-toggle-${opt.id}`}
                >
                    {opt.icon}
                </button>
            ))}
        </div>
    )
}
