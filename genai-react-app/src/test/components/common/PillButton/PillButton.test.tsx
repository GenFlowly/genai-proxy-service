import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PillButton from '../../../../components/common/PillButton/PillButton';
import '@testing-library/jest-dom';

describe('PillButton Component', () => {
    const mockOnClick = jest.fn();
    const defaultProps = {
        label: 'Test Pill',
        onClick: mockOnClick,
        'data-testid': 'test-pill'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with label and default primary variant', () => {
        render(<PillButton {...defaultProps} />);

        const button = screen.getByTestId('test-pill');
        expect(button).toBeInTheDocument();
        expect(button).toHaveTextContent('Test Pill');
        // Check for text span specifically
        expect(screen.getByTestId('test-pill-text')).toHaveTextContent('Test Pill');
        // Should not have secondary class
        expect(button.className).not.toMatch(/secondary/);
    });

    test('renders with icon when provided', () => {
        render(<PillButton {...defaultProps} icon="fake-icon.svg" />);
        const icon = screen.getByTestId('test-pill-icon');
        expect(icon).toBeInTheDocument();
        expect(screen.getByTestId('test-pill')).toContainElement(icon);
    });

    test('calls onClick when clicked', async () => {
        render(<PillButton {...defaultProps} />);
        const button = screen.getByTestId('test-pill');

        await userEvent.click(button);

        expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    test('does not call onClick when disabled', async () => {
        render(<PillButton {...defaultProps} disabled={true} />);
        const button = screen.getByTestId('test-pill');

        expect(button).toBeDisabled();

        await userEvent.click(button);

        expect(mockOnClick).not.toHaveBeenCalled();
    });

    test('handles focus and blurred states', async () => {
        render(<PillButton {...defaultProps} />);
        const button = screen.getByTestId('test-pill');

        expect(button).not.toHaveFocus();

        await userEvent.tab();

        expect(button).toHaveFocus();

        await userEvent.tab();

        expect(button).not.toHaveFocus();
    });
});
