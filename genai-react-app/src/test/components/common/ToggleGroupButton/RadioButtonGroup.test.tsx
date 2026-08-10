import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RadioButtonGroup from '../../../../components/common/ToggleGroupButton/RadioButtonGroup';
import '@testing-library/jest-dom';

describe('RadioButtonGroup Component', () => {
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
        'data-testid': 'radio-group'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders all options', () => {
        render(<RadioButtonGroup {...defaultProps} />);
        expect(screen.getByTestId('radio-group-option-opt1')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('radio-group-option-opt2')).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByTestId('radio-group-option-opt3')).toHaveAttribute('aria-pressed', 'false');
    });

    test('selecting an option toggles the other selected buttons off', async () => {
        render(<RadioButtonGroup {...defaultProps} selectedValues={['opt1', 'opt2']} />);

        await userEvent.click(screen.getByTestId('radio-group-option-opt3'));

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith(['opt3']);
    });

    test('clicking the selected option keeps it selected when empty is not allowed', async () => {
        render(<RadioButtonGroup {...defaultProps} />);

        await userEvent.click(screen.getByTestId('radio-group-option-opt1'));

        expect(mockOnChange).not.toHaveBeenCalled();
    });

    test('clicking the selected option deselects it when empty is allowed', async () => {
        render(<RadioButtonGroup {...defaultProps} allowEmpty />);

        await userEvent.click(screen.getByTestId('radio-group-option-opt1'));

        expect(mockOnChange).toHaveBeenCalledWith([]);
    });
});
