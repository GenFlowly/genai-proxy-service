import React, { useState } from 'react'
import styles from './CopyToClipboard.module.scss'
import { Icon } from '../Icon/Icon'

interface CopyToClipboardProps {
    content: string
    label?: string
    buttonText?: string // To override label/icon mix
    successMessage?: string
    successDuration?: number
    disabled?: boolean
    className?: string
    size?: 'sm' | 'md' | 'lg'
    variant?: 'primary' | 'secondary'
    icon?: string
}

export default function CopyToClipboard({
    content,
    label = 'Copy',
    successMessage = '✓ Copied',
    successDuration = 2000,
    disabled = false,
    className = '',
    size = 'sm',
    variant = 'primary',
    icon,
}: CopyToClipboardProps): React.ReactElement {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content)
            setCopied(true)
            setTimeout(() => setCopied(false), successDuration!)
        } catch (err) {
            console.error('Failed to copy:', err)
        }
    }

    const isDisabled = disabled || !content

    return (
        <button
            onClick={handleCopy}
            disabled={isDisabled}
            className={`${styles.copyToClipboard} ${styles[size]} ${styles[variant]} ${className}`}
            title={label}
        >
            {copied ? successMessage : (
                icon ? <Icon src={icon} size="1.2em" /> : label
            )}
        </button>
    )
}