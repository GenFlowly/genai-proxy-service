import React from 'react'
import styles from './InputTextWithHint.module.scss'
import { Icon } from '../Icon/Icon'

interface InputTextWithHintProps {
    hint: string
    icon?: string
    placeholder?: string
    value?: string
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
    className?: string
    autoFocus?: boolean
    'data-testid'?: string
}

export const InputTextWithHint: React.FC<InputTextWithHintProps> = ({
    hint,
    icon,
    placeholder,
    value,
    onChange,
    className = '',
    autoFocus = false,
    'data-testid': testId
}) => {
    return (
        <div className={`${styles.container} ${className}`} data-testid={testId ? `${testId}-container` : undefined}>
            <div className={styles.prefixArea}>
                {icon && <Icon src={icon} size={16} className={styles.icon} data-testid={testId ? `${testId}-icon` : undefined} />}
                <span className={styles.hintText} data-testid={testId ? `${testId}-hint` : undefined}>{hint}</span>
            </div>
            <input
                type="text"
                className={styles.inputElement}
                placeholder={placeholder}
                value={value}
                onChange={onChange}
                autoFocus={autoFocus}
                data-testid={testId}
            />
        </div>
    )
}
