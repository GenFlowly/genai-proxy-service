import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CheckboxButtonGroup from '../../../../components/common/ToggleGroupButton/CheckboxButtonGroup';
import '@testing-library/jest-dom';

describe('CheckboxButtonGroup Component', () => {
    const mockOnChange = jest.fn();
    const options = [
        { id: 'opt1', label: 'Option 1' },
        { id: 'opt2', label: 'Option 2' },
        { id: 'opt3', label: 'Option 3' }
    ];
    const defaultProps = {
        options: options,
        selectedValues: ['opt1'],
        onChange: mockOnChange,
        maxSelection: 2,
        'data-testid': 'checkbox-group'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('selecting below the max does not toggle other selected buttons', async () => {
        render(<CheckboxButtonGroup {...defaultProps} />);

        await userEvent.click(screen.getByTestId('checkbox-group-option-opt2'));

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith(['opt1', 'opt2']);
    });

    test('selecting at the max drops the oldest selection', async () => {
        render(<CheckboxButtonGroup {...defaultProps} selectedValues={['opt1', 'opt2']} />);

        await userEvent.click(screen.getByTestId('checkbox-group-option-opt3'));

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith(['opt2', 'opt3']);
    });

    test('options are not disabled at the max', () => {
        render(<CheckboxButtonGroup {...defaultProps} selectedValues={['opt1', 'opt2']} />);

        expect(screen.getByTestId('checkbox-group-option-opt3')).not.toBeDisabled();
    });

    test('deselecting a selected option works below and at the max', async () => {
        render(<CheckboxButtonGroup {...defaultProps} selectedValues={['opt1', 'opt2']} />);

        await userEvent.click(screen.getByTestId('checkbox-group-option-opt1'));

        expect(mockOnChange).toHaveBeenCalledWith(['opt2']);
    });

    test('does not deselect the last option when empty is not allowed', async () => {
        render(<CheckboxButtonGroup {...defaultProps} />);

        await userEvent.click(screen.getByTestId('checkbox-group-option-opt1'));

        expect(mockOnChange).not.toHaveBeenCalled();
    });

    test('with maxSelection of 1 a new selection replaces the current one', async () => {
        render(<CheckboxButtonGroup {...defaultProps} maxSelection={1} />);

        await userEvent.click(screen.getByTestId('checkbox-group-option-opt3'));

        expect(mockOnChange).toHaveBeenCalledWith(['opt3']);
    });
});
