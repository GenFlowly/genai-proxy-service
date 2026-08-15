import React from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon/Icon'
import styles from './ToggleGroupButton.module.scss'

export interface ToggleOption {
    id: string
    label: string
    icon?: string
}

interface ToggleGroupButtonProps {
    options: ToggleOption[]
    selectedValues: string[]
    onChange: (selectedValues: string[]) => void
    allowEmpty?: boolean
    singleSelection?: boolean
    maxSelection?: number
    // When the max is reached, selecting a new option drops the oldest
    // selection instead of disabling the remaining buttons
    replaceOldestAtMax?: boolean
    className?: string
    'data-testid'?: string
}

export default function ToggleGroupButton({
    options,
    selectedValues,
    onChange,
    allowEmpty = false,
    singleSelection = false,
    maxSelection,
    replaceOldestAtMax = false,
    className = '',
    'data-testid': testId
}: ToggleGroupButtonProps): React.ReactElement {
    const { t } = useTranslation()

    const handleToggle = (optionId: string) => {
        const isSelected = selectedValues.includes(optionId)
        let newSelection: string[]

        if (singleSelection) {
            // Single selection mode logic
            if (isSelected) {
                // If clicking already selected item
                if (!allowEmpty) {
                    // If empty not allowed, keep it selected (no change)
                    return
                }
                // If empty allowed, deselect it
                newSelection = []
            } else {
                // Select the new item, replace others
                newSelection = [optionId]
            }
        } else {
            // Multi-selection mode logic (default)
            if (isSelected) {
                newSelection = selectedValues.filter(id => id !== optionId)
            } else if (replaceOldestAtMax && maxSelection !== undefined && selectedValues.length >= maxSelection) {
                // At capacity: drop the oldest selection to make room
                newSelection = [...selectedValues.slice(selectedValues.length - (maxSelection - 1)), optionId]
            } else {
                newSelection = [...selectedValues, optionId]
            }
        }

        // Visualize logic: if emptying is not allowed and new selection is empty, revert (do nothing)
        if (!allowEmpty && newSelection.length === 0) {
            return
        }

        onChange(newSelection)
    }

    if (!options || options.length === 0) return <></>

    return (
        <div className={`${styles.toggleGroup} ${className}`} data-testid={testId}>
            {options.map((option) => {
                const isActive = selectedValues.includes(option.id)
                const isMaxReached = maxSelection !== undefined && selectedValues.length >= maxSelection
                const isDisabled = !isActive && isMaxReached && !replaceOldestAtMax

                return (
                    <button
                        key={option.id}
                        className={`${styles.toggleButton} ${isActive ? styles.active : ''} ${isDisabled ? styles.disabled : ''}`}
                        onClick={() => !isDisabled && handleToggle(option.id)}
                        type="button"
                        aria-pressed={isActive}
                        aria-label={t('common.toggleGroupButton.toggleOption', { label: option.label })}
                        aria-disabled={isDisabled}
                        disabled={isDisabled}
                        data-testid={testId ? `${testId}-option-${option.id}` : undefined}
                    >
                        {option.icon && <Icon src={option.icon} size={16} data-testid={testId ? `${testId}-option-${option.id}-icon` : undefined} />}
                        <span>{option.label}</span>
                    </button>
                )
            })}
        </div>
    )
}
