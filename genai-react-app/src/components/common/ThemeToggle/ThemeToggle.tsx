import React from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../../context/ThemeContext'
import { Icon } from '../Icon/Icon'
import { ICONS } from '../../../constants/icons'
import styles from './ThemeToggle.module.scss'

interface ThemeToggleProps {
    className?: string
    'data-testid'?: string
}

export default function ThemeToggle({ className = '', 'data-testid': testId }: ThemeToggleProps = {}) {
    const { t } = useTranslation()
    const { themeMode, setThemeMode } = useTheme()

    const options = [
        { id: 'light', icon: ICONS.SUN, label: t('common.themeToggle.lightTheme') },
        { id: 'system', icon: ICONS.LAPTOP, label: t('common.themeToggle.systemTheme') },
        { id: 'dark', icon: ICONS.MOON, label: t('common.themeToggle.darkTheme') }
    ] as const;

    return (
        <div 
            className={`${styles.themeToggleContainer} ${className}`} 
            data-testid={testId || 'theme-toggle'}
            aria-label={t('common.themeToggle.themeSelection')}
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
                    <Icon src={opt.icon} size={14} alt={opt.label} />
                </button>
            ))}
        </div>
    )
}
