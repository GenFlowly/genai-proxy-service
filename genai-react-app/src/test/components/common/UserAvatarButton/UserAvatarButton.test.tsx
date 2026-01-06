import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserAvatarButton } from '../../../../components/common/UserAvatarButton/UserAvatarButton';
import '@testing-library/jest-dom';

describe('UserAvatarButton Component', () => {
    const mockOnClick = jest.fn();
    const defaultProps = {
        displayName: 'Test User',
        onClick: mockOnClick,
        'data-testid': 'test-avatar'
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders default icon when no picture provided', () => {
        render(<UserAvatarButton {...defaultProps} />);

        const button = screen.getByTestId('test-avatar');
        expect(button).toBeInTheDocument();
        expect(button).toHaveAttribute('title', 'Test User');

        const icon = screen.getByTestId('test-avatar-icon');
        expect(icon).toBeInTheDocument();
        expect(screen.queryByTestId('test-avatar-image')).not.toBeInTheDocument();
    });

    test('renders image when picture is provided', () => {
        render(
            <UserAvatarButton
                {...defaultProps}
                displayPicture="https://example.com/avatar.jpg"
            />
        );

        const image = screen.getByTestId('test-avatar-image');
        expect(image).toBeInTheDocument();
        expect(image).toHaveAttribute('src', 'https://example.com/avatar.jpg');
        expect(image).toHaveAttribute('alt', 'Test User');
        expect(screen.queryByTestId('test-avatar-icon')).not.toBeInTheDocument();
    });

    test('handles click events', async () => {
        render(<UserAvatarButton {...defaultProps} />);
        const button = screen.getByTestId('test-avatar');

        await userEvent.click(button);
        expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    test('handles focus states', async () => {
        render(<UserAvatarButton {...defaultProps} />);
        const button = screen.getByTestId('test-avatar');

        await userEvent.tab();
        expect(button).toHaveFocus();

        await userEvent.tab();
        expect(button).not.toHaveFocus();
    });

    test('respects disabled state', async () => {
        render(<UserAvatarButton {...defaultProps} disabled />);
        const button = screen.getByTestId('test-avatar');

        expect(button).toBeDisabled();

        await userEvent.click(button);
        expect(mockOnClick).not.toHaveBeenCalled();
    });
});
