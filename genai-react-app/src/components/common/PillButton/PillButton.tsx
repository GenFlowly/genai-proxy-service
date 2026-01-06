import React, { ButtonHTMLAttributes } from 'react'
import styles from './PillButton.module.scss'
import { Icon } from '../Icon/Icon'

export interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    label: React.ReactNode
    icon?: string
    variant?: 'primary' | 'secondary'
    'data-testid'?: string
}

export default function PillButton({
    label,
    icon,
    className = '',
    variant = 'primary',
    'data-testid': testId,
    ...props
}: PillButtonProps): React.ReactElement {
    const variantClass = variant === 'secondary' ? styles.secondary : ''

    return (
        <button
            className={`${styles.pillButton} ${variantClass} ${className}`}
            data-testid={testId}
            {...props}
        >
            {icon && <Icon src={icon} size={16} data-testid={testId ? `${testId}-icon` : undefined} />}
            {typeof label === 'string' ? <span data-testid={testId ? `${testId}-text` : undefined}>{label}</span> : label}
        </button>
    )
}
