import React from 'react'
import styles from './MultiPurposeButton.module.scss'

interface ButtonProps {
    label: string
    onClick: () => void
    disabled?: boolean
}

export default function MultiPurposeButton({ label, onClick, disabled = false }: ButtonProps) {
    return (
        <button
            onClick={onClick}
            className={styles.submitButton}
            disabled={disabled}
        >
            {label}
        </button>
    )
}
