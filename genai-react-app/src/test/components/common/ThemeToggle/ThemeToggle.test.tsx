import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from '../../../../components/common/ThemeToggle/ThemeToggle';
import * as ThemeContext from '../../../../context/ThemeContext';
import '@testing-library/jest-dom';

// Mock useTheme
jest.mock('../../../../context/ThemeContext', () => ({
    useTheme: jest.fn()
}));

describe('ThemeToggle Component', () => {
    const mockUseTheme = ThemeContext.useTheme as jest.Mock;
    const mockToggleTheme = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders light theme state correctly', () => {
        mockUseTheme.mockReturnValue({
            theme: 'light',
            toggleTheme: mockToggleTheme
        });

        render(<ThemeToggle />);

        const button = screen.getByTestId('theme-toggle');
        expect(button).toBeInTheDocument();
        expect(button).toHaveTextContent('🌙'); // Moon icon for switching TO dark
        expect(button).toHaveAttribute('aria-label', 'Switch to dark theme');
        expect(button).toHaveAttribute('title', 'Switch to dark theme');
    });

    test('renders dark theme state correctly', () => {
        mockUseTheme.mockReturnValue({
            theme: 'dark',
            toggleTheme: mockToggleTheme
        });

        render(<ThemeToggle />);

        const button = screen.getByTestId('theme-toggle');
        expect(button).toBeInTheDocument();
        expect(button).toHaveTextContent('☀️'); // Sun icon for switching TO light
        expect(button).toHaveAttribute('aria-label', 'Switch to light theme');
        expect(button).toHaveAttribute('title', 'Switch to light theme');
    });

    test('calls toggleTheme on click', async () => {
        mockUseTheme.mockReturnValue({
            theme: 'light',
            toggleTheme: mockToggleTheme
        });

        render(<ThemeToggle />);
        const button = screen.getByTestId('theme-toggle');

        await userEvent.click(button);

        expect(mockToggleTheme).toHaveBeenCalledTimes(1);
    });

    test('applies custom className', () => {
        mockUseTheme.mockReturnValue({
            theme: 'light',
            toggleTheme: mockToggleTheme
        });

        render(<ThemeToggle className="custom-class" />);
        const button = screen.getByTestId('theme-toggle');
        expect(button).toHaveClass('custom-class');
    });
});
