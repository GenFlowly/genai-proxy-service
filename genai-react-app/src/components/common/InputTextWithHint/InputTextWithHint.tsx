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
}

export const InputTextWithHint: React.FC<InputTextWithHintProps> = ({
    hint,
    icon,
    placeholder,
    value,
    onChange,
    className = '',
}) => {
    return (
        <div className={`${styles.container} ${className}`}>
            <div className={styles.prefixArea}>
                {icon && <Icon src={icon} size={16} className={styles.icon} />}
                <span className={styles.hintText}>{hint}</span>
            </div>
            <input
                type="text"
                className={styles.input}
                placeholder={placeholder}
                value={value}
                onChange={onChange}
            />
        </div>
    )
}
