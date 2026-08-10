import React from 'react'
import ToggleGroupButton, { ToggleOption } from './ToggleGroupButton'

interface CheckboxButtonGroupProps {
    options: ToggleOption[]
    selectedValues: string[]
    onChange: (selectedValues: string[]) => void
    maxSelection: number
    allowEmpty?: boolean
    className?: string
    'data-testid'?: string
}

/**
 * Checkbox-style view of ToggleGroupButton: options toggle independently
 * and other selected buttons are left alone until maxSelection is reached —
 * from then on, selecting a new option drops the oldest selection.
 */
export default function CheckboxButtonGroup({
    options,
    selectedValues,
    onChange,
    maxSelection,
    allowEmpty = false,
    className = '',
    'data-testid': testId
}: CheckboxButtonGroupProps): React.ReactElement {
    return (
        <ToggleGroupButton
            options={options}
            selectedValues={selectedValues}
            onChange={onChange}
            allowEmpty={allowEmpty}
            maxSelection={maxSelection}
            replaceOldestAtMax
            className={className}
            data-testid={testId}
        />
    )
}
