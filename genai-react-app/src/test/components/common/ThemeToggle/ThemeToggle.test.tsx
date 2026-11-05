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
    const mockSetThemeMode = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders all theme options', () => {
        mockUseTheme.mockReturnValue({
            themeMode: 'system',
            setThemeMode: mockSetThemeMode
        });

        render(<ThemeToggle />);

        expect(screen.getByTestId('theme-toggle-light')).toBeInTheDocument();
        expect(screen.getByTestId('theme-toggle-system')).toBeInTheDocument();
        expect(screen.getByTestId('theme-toggle-dark')).toBeInTheDocument();
    });

    test('calls setThemeMode on click', async () => {
        mockUseTheme.mockReturnValue({
            themeMode: 'system',
            setThemeMode: mockSetThemeMode
        });

        render(<ThemeToggle />);
        
        await userEvent.click(screen.getByTestId('theme-toggle-dark'));
        expect(mockSetThemeMode).toHaveBeenCalledWith('dark');

        await userEvent.click(screen.getByTestId('theme-toggle-light'));
        expect(mockSetThemeMode).toHaveBeenCalledWith('light');
    });

    test('applies custom className', () => {
        mockUseTheme.mockReturnValue({
            themeMode: 'light',
            setThemeMode: mockSetThemeMode
        });

        render(<ThemeToggle className="custom-class" />);
        const container = screen.getByTestId('theme-toggle');
        expect(container).toHaveClass('custom-class');
    });

    test('marks the current mode as pressed', () => {
        mockUseTheme.mockReturnValue({
            themeMode: 'dark',
            setThemeMode: mockSetThemeMode
        });

        render(<ThemeToggle variant="surface" />);

        expect(screen.getByTestId('theme-toggle-dark')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('theme-toggle-light')).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('group')).toBeInTheDocument();
    });
});
