import React from 'react'
import ToggleGroupButton, { ToggleOption } from './ToggleGroupButton'

interface RadioButtonGroupProps {
    options: ToggleOption[]
    selectedValues: string[]
    onChange: (selectedValues: string[]) => void
    allowEmpty?: boolean
    className?: string
    'data-testid'?: string
}

/**
 * Radio-style view of ToggleGroupButton: selecting a button toggles any
 * other selected button off, so at most one option is selected.
 */
export default function RadioButtonGroup({
    options,
    selectedValues,
    onChange,
    allowEmpty = false,
    className = '',
    'data-testid': testId
}: RadioButtonGroupProps): React.ReactElement {
    return (
        <ToggleGroupButton
            options={options}
            selectedValues={selectedValues}
            onChange={onChange}
            allowEmpty={allowEmpty}
            singleSelection
            className={className}
            data-testid={testId}
        />
    )
}
