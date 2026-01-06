import React from 'react'
import styles from './MultiPurposeButton.module.scss'

import { Icon } from '../Icon/Icon'

interface ButtonProps {
    label: string
    onClick: () => void
    disabled?: boolean
    icon?: string
    'data-testid'?: string
}

export default function MultiPurposeButton({ label, onClick, disabled = false, icon, 'data-testid': testId }: ButtonProps) {
    return (
        <button
            onClick={onClick}
            className={styles.submitButton}
            disabled={disabled}
            data-testid={testId}
        >
            {label}
            {icon && <Icon src={icon} data-testid={testId ? `${testId}-icon` : undefined} />}
        </button>
    )
}
