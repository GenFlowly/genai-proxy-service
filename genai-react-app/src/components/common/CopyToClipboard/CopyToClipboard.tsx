import React, { useState } from 'react'
import styles from './CopyToClipboard.module.scss'

interface CopyToClipboardProps {
    content: string
    label?: string
    successMessage?: string
    successDuration: number
    disabled?: boolean
    className?: string
    size?: 'sm' | 'md' | 'lg'
    variant?: 'primary' | 'secondary'
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
                                   }: CopyToClipboardProps): React.ReactElement {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content)
            setCopied(true)
            setTimeout(() => setCopied(false), successDuration)
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
            title={`Copy content to clipboard`}
        >
            {copied ? successMessage : label}
        </button>
    )
}