import React from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../../context/ThemeContext'
import { Icon } from '@genflowly/component-library'
import { ICONS } from '../../../constants/icons'
import styles from './ThemeToggle.module.scss'

interface ThemeToggleProps {
    className?: string
    /** `navbar` fits the dark menu bar; `surface` is touch-sized for a themed page. */
    variant?: 'navbar' | 'surface'
    'data-testid'?: string
}

export default function ThemeToggle({ className = '', variant = 'navbar', 'data-testid': testId }: ThemeToggleProps = {}) {
    const { t } = useTranslation()
    const { themeMode, setThemeMode } = useTheme()

    const options = [
        { id: 'light', icon: ICONS.SUN, label: t('common.themeToggle.lightTheme') },
        { id: 'system', icon: ICONS.LAPTOP, label: t('common.themeToggle.systemTheme') },
        { id: 'dark', icon: ICONS.MOON, label: t('common.themeToggle.darkTheme') }
    ] as const;

    return (
        <div
            className={`${styles.themeToggleContainer} ${variant === 'surface' ? styles.surface : ''} ${className}`}
            data-testid={testId || 'theme-toggle'}
            role="group"
            aria-label={t('common.themeToggle.themeSelection')}
        >
            <div
                className={styles.slider}
                data-active={themeMode}
            />
            {options.map((opt) => (
                <button
                    key={opt.id}
                    type="button"
                    className={`${styles.toggleOption} ${themeMode === opt.id ? styles.active : ''}`}
                    onClick={() => setThemeMode(opt.id)}
                    title={opt.label}
                    aria-label={opt.label}
                    aria-pressed={themeMode === opt.id}
                    data-testid={`theme-toggle-${opt.id}`}
                >
                    <Icon src={opt.icon} size={variant === 'surface' ? 20 : 12} alt={opt.label} />
                </button>
            ))}
        </div>
    )
}
