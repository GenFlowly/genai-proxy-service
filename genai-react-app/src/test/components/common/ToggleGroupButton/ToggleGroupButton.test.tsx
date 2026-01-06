import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToggleGroupButton from '../../../../components/common/ToggleGroupButton/ToggleGroupButton';
import '@testing-library/jest-dom';

describe('ToggleGroupButton Component', () => {
    const mockOnChange = jest.fn();
    const options = [
        { id: 'opt1', label: 'Option 1' },
        { id: 'opt2', label: 'Option 2', icon: 'icon.svg' }
    ];
    const defaultProps = {
        options: options,
        selectedValues: ['opt1'],
        onChange: mockOnChange,
        'data-testid': 'test-group'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders all options correctly', () => {
        render(<ToggleGroupButton {...defaultProps} />);

        const group = screen.getByTestId('test-group');
        expect(group).toBeInTheDocument();

        const opt1 = screen.getByTestId('test-group-option-opt1');
        const opt2 = screen.getByTestId('test-group-option-opt2');

        expect(opt1).toBeInTheDocument();
        expect(opt1).toHaveTextContent('Option 1');
        // opt1 is selected
        expect(opt1).toHaveAttribute('aria-pressed', 'true');
        expect(opt1.className).toMatch(/active/);

        expect(opt2).toBeInTheDocument();
        expect(opt2).toHaveTextContent('Option 2');
        // opt2 is not selected
        expect(opt2).toHaveAttribute('aria-pressed', 'false');
        expect(opt2.className).not.toMatch(/active/);

        // Icon check
        expect(screen.getByTestId('test-group-option-opt2-icon')).toBeInTheDocument();
    });

    test('calls onChange when unselected option is clicked (select)', async () => {
        render(<ToggleGroupButton {...defaultProps} />);
        const opt2 = screen.getByTestId('test-group-option-opt2');

        await userEvent.click(opt2);

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith(['opt1', 'opt2']);
    });

    test('calls onChange when selected option is clicked (deselect)', async () => {
        render(
            <ToggleGroupButton
                {...defaultProps}
                selectedValues={['opt1', 'opt2']}
            />
        );
        const opt2 = screen.getByTestId('test-group-option-opt2');

        await userEvent.click(opt2);

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith(['opt1']);
    });

    test('respects allowEmpty=false (cannot deselect last item)', async () => {
        render(
            <ToggleGroupButton
                {...defaultProps}
                selectedValues={['opt1']}
                allowEmpty={false}
            />
        );
        const opt1 = screen.getByTestId('test-group-option-opt1');

        await userEvent.click(opt1);

        expect(mockOnChange).not.toHaveBeenCalled();
    });

    test('respects allowEmpty=true (can deselect last item)', async () => {
        render(
            <ToggleGroupButton
                {...defaultProps}
                selectedValues={['opt1']}
                allowEmpty={true}
            />
        );
        const opt1 = screen.getByTestId('test-group-option-opt1');

        await userEvent.click(opt1);

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith([]);
    });

    test('handles focus navigation', async () => {
        render(<ToggleGroupButton {...defaultProps} />);
        const opt1 = screen.getByTestId('test-group-option-opt1');
        const opt2 = screen.getByTestId('test-group-option-opt2');

        await userEvent.tab();
        expect(opt1).toHaveFocus();

        await userEvent.tab();
        expect(opt2).toHaveFocus();

        await userEvent.tab();
        expect(opt2).not.toHaveFocus();
    });
});
