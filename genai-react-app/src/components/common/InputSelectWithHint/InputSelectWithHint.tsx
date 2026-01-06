import React from 'react'
import styles from './InputSelectWithHint.module.scss'
import { Icon } from '../Icon/Icon'

export interface SelectOption {
    label: string
    value: string
    isCta?: boolean
    ctaAction?: () => void
    style?: React.CSSProperties
}

interface InputSelectWithHintProps {
    hint: string
    icon?: string
    value?: string
    onChange?: (value: string) => void
    options: SelectOption[]
    className?: string
    placeholder?: string
    'data-testid'?: string
}

export const InputSelectWithHint: React.FC<InputSelectWithHintProps> = ({
    hint,
    icon,
    value,
    onChange,
    options,
    className = '',
    placeholder = 'Select an option',
    'data-testid': testId
}) => {

    const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newValue = e.target.value
        const selectedOption = options.find(opt => opt.value === newValue)

        if (selectedOption?.isCta) {
            selectedOption.ctaAction?.()
            return
        }

        onChange?.(newValue)
    }

    return (
        <div className={`${styles.container} ${className}`}>
            <div className={styles.prefixArea}>
                {icon && <Icon src={icon} size={16} className={styles.icon} />}
                <span className={styles.hintText}>{hint}</span>
            </div>
            <select
                className={styles.inputElement}
                value={value || ''}
                onChange={handleSelectChange}
                data-testid={testId}
            >
                <option value="" disabled>{placeholder}</option>
                {options.map((opt) => (
                    <option
                        key={opt.value}
                        value={opt.value}
                        style={opt.style || (opt.isCta ? { fontWeight: 'bold', color: 'blue' } : undefined)}
                    >
                        {opt.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
