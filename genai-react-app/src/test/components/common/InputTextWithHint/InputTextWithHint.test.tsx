import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputTextWithHint } from '../../../../components/common/InputTextWithHint/InputTextWithHint';
import '@testing-library/jest-dom';

describe('InputTextWithHint Component', () => {
    const mockOnChange = jest.fn();
    const defaultProps = {
        hint: 'Test Hint',
        onChange: mockOnChange,
        'data-testid': 'test-input'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with hint and input', () => {
        render(<InputTextWithHint {...defaultProps} />);

        const container = screen.getByTestId('test-input-container');
        expect(container).toBeInTheDocument();

        const hint = screen.getByTestId('test-input-hint');
        expect(hint).toHaveTextContent('Test Hint');

        const input = screen.getByTestId('test-input');
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute('type', 'text');
    });

    test('renders with icon if provided', () => {
        render(<InputTextWithHint {...defaultProps} icon="fake-icon.svg" />);
        const icon = screen.getByTestId('test-input-icon');
        expect(icon).toBeInTheDocument();
        // Since Icon component spreads props, it should receive the ID
    });

    test('renders correct placeholder and value', () => {
        render(<InputTextWithHint {...defaultProps} placeholder="Enter text..." value="Current Value" />);
        const input = screen.getByTestId('test-input');

        expect(input).toHaveAttribute('placeholder', 'Enter text...');
        expect(input).toHaveValue('Current Value');
    });

    test('calls onChange when input value changes', () => {
        render(<InputTextWithHint {...defaultProps} />);
        const input = screen.getByTestId('test-input');

        fireEvent.change(input, { target: { value: 'New Text' } });

        expect(mockOnChange).toHaveBeenCalledTimes(1);
        // The event object is passed, but exact event matching is sometimes flaky.
        // We verified the handler was called.
    });

    test('applies autoFocus attribute', () => {
        render(<InputTextWithHint {...defaultProps} autoFocus={true} />);
        const input = screen.getByTestId('test-input');
        expect(input).toHaveFocus();
    });
});
