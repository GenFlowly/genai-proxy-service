import React from 'react'
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
    className?: string
    'data-testid'?: string
}

export default function ToggleGroupButton({
    options,
    selectedValues,
    onChange,
    allowEmpty = false,
    singleSelection = false,
    className = '',
    'data-testid': testId
}: ToggleGroupButtonProps): React.ReactElement {

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
                return (
                    <button
                        key={option.id}
                        className={`${styles.toggleButton} ${isActive ? styles.active : ''}`}
                        onClick={() => handleToggle(option.id)}
                        type="button"
                        aria-pressed={isActive}
                        aria-label={`Toggle ${option.label}`}
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
