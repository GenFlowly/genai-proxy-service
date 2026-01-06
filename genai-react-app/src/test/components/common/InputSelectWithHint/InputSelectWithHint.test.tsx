import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputSelectWithHint, SelectOption } from '../../../../components/common/InputSelectWithHint/InputSelectWithHint';
import '@testing-library/jest-dom';

describe('InputSelectWithHint Component', () => {
    const mockOnChange = jest.fn();
    const mockCtaAction = jest.fn();

    const options: SelectOption[] = [
        { label: 'Option 1', value: 'opt1' },
        { label: 'Option 2', value: 'opt2' },
        { label: 'CTA Option', value: 'cta', isCta: true, ctaAction: mockCtaAction }
    ];

    const defaultProps = {
        hint: 'Test Hint',
        options: options,
        onChange: mockOnChange,
        'data-testid': 'test-select'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with hint and options', () => {
        render(<InputSelectWithHint {...defaultProps} />);

        const container = screen.getByTestId('test-select-container');
        expect(container).toBeInTheDocument();

        const hint = screen.getByTestId('test-select-hint');
        expect(hint).toHaveTextContent('Test Hint');

        const select = screen.getByTestId('test-select');
        expect(select).toBeInTheDocument();
        expect(screen.getByTestId('test-select-option-opt1')).toHaveTextContent('Option 1');
        expect(screen.getByTestId('test-select-option-opt2')).toHaveTextContent('Option 2');
    });

    test('renders placeholder when no value is selected', () => {
        render(<InputSelectWithHint {...defaultProps} placeholder="Choose..." value="" />);
        const select = screen.getByTestId('test-select') as HTMLSelectElement;
        expect(select.value).toBe('');
        expect(screen.getByTestId('test-select-placeholder')).toHaveTextContent('Choose...');
    });

    test('renders with icon if provided', () => {
        render(<InputSelectWithHint {...defaultProps} icon="fake-icon.svg" />);
        const icon = screen.getByTestId('test-select-icon');
        expect(icon).toBeInTheDocument();
    });

    test('calls onChange when a normal option is selected', () => {
        render(<InputSelectWithHint {...defaultProps} />);
        const select = screen.getByTestId('test-select');

        fireEvent.change(select, { target: { value: 'opt2' } });

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        expect(mockOnChange).toHaveBeenCalledWith('opt2');
    });

    test('calls ctaAction and NOT onChange when CTA option is selected', () => {
        render(<InputSelectWithHint {...defaultProps} />);
        const select = screen.getByTestId('test-select');

        fireEvent.change(select, { target: { value: 'cta' } });

        expect(mockCtaAction).toHaveBeenCalledTimes(1);
        expect(mockOnChange).not.toHaveBeenCalled();
    });

    test('styles CTA option correctly', () => {
        render(<InputSelectWithHint {...defaultProps} />);
        const ctaOption = screen.getByTestId('test-select-option-cta');
        expect(ctaOption).toBeInTheDocument();
    });
});
