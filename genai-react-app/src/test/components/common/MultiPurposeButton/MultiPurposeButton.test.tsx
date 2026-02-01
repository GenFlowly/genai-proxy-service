import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MultiPurposeButton from '../../../../components/common/MultiPurposeButton/MultiPurposeButton';
import '@testing-library/jest-dom';

describe('MultiPurposeButton Component', () => {
    const mockOnClick = jest.fn();
    const defaultProps = {
        label: 'Test Button',
        onClick: mockOnClick,
        'data-testid': 'test-button'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders with label', () => {
        render(<MultiPurposeButton {...defaultProps} />);

        const button = screen.getByTestId('test-button');
        expect(button).toBeInTheDocument();
        expect(button).toHaveTextContent('Test Button');
    });

    test('renders with icon when provided', () => {
        render(<MultiPurposeButton {...defaultProps} icon="fake-icon.svg" />);

        const icon = screen.getByTestId('test-button-icon');
        expect(icon).toBeInTheDocument();
        // Icon should render inside the button
        expect(screen.getByTestId('test-button')).toContainElement(icon);
    });

    test('calls onClick when clicked', async () => {
        render(<MultiPurposeButton {...defaultProps} />);
        const button = screen.getByTestId('test-button');

        await userEvent.click(button);

        expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    test('does not call onClick when disabled', async () => {
        render(<MultiPurposeButton {...defaultProps} disabled={true} />);
        const button = screen.getByTestId('test-button');

        expect(button).toBeDisabled();

        await userEvent.click(button);

        expect(mockOnClick).not.toHaveBeenCalled();
    });

    test('handles focus and blurred states', async () => {
        render(<MultiPurposeButton {...defaultProps} />);
        const button = screen.getByTestId('test-button');

        expect(button).not.toHaveFocus();

        await userEvent.tab();

        expect(button).toHaveFocus();

        await userEvent.tab();

        expect(button).not.toHaveFocus();
    });

});
// Trigger coverage check
