import React, { ButtonHTMLAttributes } from 'react'
import styles from './PillButton.module.scss'
import { Icon } from '../Icon/Icon'

export interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    label: React.ReactNode
    icon?: string
    variant?: 'primary' | 'secondary'
}

export default function PillButton({
    label,
    icon,
    className = '',
    variant = 'primary',
    ...props
}: PillButtonProps): React.ReactElement {
    const variantClass = variant === 'secondary' ? styles.secondary : ''

    return (
        <button
            className={`${styles.pillButton} ${variantClass} ${className}`}
            {...props}
        >
            {icon && <Icon src={icon} size={16} />}
            {typeof label === 'string' ? <span>{label}</span> : label}
        </button>
    )
}
