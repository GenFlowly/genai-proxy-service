import React from 'react'
import styles from './MultiPurposeButton.module.scss'

import { Icon } from '../Icon/Icon'

interface ButtonProps {
    label: string
    onClick: () => void
    disabled?: boolean
    icon?: string
}

export default function MultiPurposeButton({ label, onClick, disabled = false, icon }: ButtonProps) {
    return (
        <button
            onClick={onClick}
            className={styles.submitButton}
            disabled={disabled}
        >
            {label}
            {icon && <Icon src={icon} />}
        </button>
    )
}
