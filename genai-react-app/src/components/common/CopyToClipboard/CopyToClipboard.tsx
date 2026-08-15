import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './CopyToClipboard.module.scss'
import { Icon } from '../Icon/Icon'

interface CopyToClipboardProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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
    label,
    successMessage,
    successDuration = 2000,
    disabled = false,
    className = '',
    size = 'sm',
    variant = 'primary',
    icon,
    ...props
}: CopyToClipboardProps): React.ReactElement {
    const { t } = useTranslation()
    const [copied, setCopied] = useState(false)

    const resolvedLabel = label ?? t('common.copyToClipboard.copy')
    const resolvedSuccessMessage = successMessage ?? t('common.copyToClipboard.copied')

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
            title={resolvedLabel}
            data-testid="copy-to-clipboard-button"
            {...props}
        >
            {copied ? resolvedSuccessMessage : (
                icon ? <Icon src={icon} size="1.2em" /> : resolvedLabel
            )}
        </button>
    )
}