import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../context/ThemeContext';

const TestComponent = () => {
    const { theme, toggleTheme, setTheme } = useTheme();
    return (
        <div>
            <span data-testid="theme">{theme}</span>
            <button onClick={toggleTheme} data-testid="toggle">Toggle</button>
            <button onClick={() => setTheme('dark')} data-testid="set-dark">Set Dark</button>
        </div>
    );
};

describe('ThemeContext', () => {
    let matchMediaMock: jest.Mock;
    let addEventListenerMock: jest.Mock;
    let removeEventListenerMock: jest.Mock;

    beforeEach(() => {
        localStorage.clear();
        document.documentElement.setAttribute('data-theme', '');

        // Mock matchMedia
        addEventListenerMock = jest.fn();
        removeEventListenerMock = jest.fn();
        matchMediaMock = jest.fn().mockImplementation((query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: jest.fn(), // Deprecated
            removeListener: jest.fn(), // Deprecated
            addEventListener: addEventListenerMock,
            removeEventListener: removeEventListenerMock,
            dispatchEvent: jest.fn(),
        }));
        window.matchMedia = matchMediaMock;
    });

    test('initializes with default light theme if no preference', () => {
        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );
        expect(screen.getByTestId('theme')).toHaveTextContent('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    test('initializes with saved theme from localStorage', () => {
        localStorage.setItem('theme', 'dark');
        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );
        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('initializes with system preference (dark) if no local storage', () => {
        matchMediaMock.mockImplementation((query) => ({
            matches: query === '(prefers-color-scheme: dark)',
            media: query,
            addEventListener: addEventListenerMock,
            removeEventListener: removeEventListenerMock,
        }));

        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );
        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    });

    test('toggles theme', () => {
        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );
        const toggle = screen.getByTestId('toggle');

        // Light -> Dark
        fireEvent.click(toggle);
        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
        expect(localStorage.getItem('theme')).toBe('dark');

        // Dark -> Light
        fireEvent.click(toggle);
        expect(screen.getByTestId('theme')).toHaveTextContent('light');
        expect(localStorage.getItem('theme')).toBe('light');
    });

    test('sets theme explicitly', () => {
        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );
        fireEvent.click(screen.getByTestId('set-dark'));
        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
        expect(localStorage.getItem('theme')).toBe('dark');
    });

    test('updates on system preference change if no user preference', () => {
        // Setup listener capture
        let changeHandler: any = null;
        addEventListenerMock.mockImplementation((event, handler) => {
            if (event === 'change') changeHandler = handler;
        });

        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );

        // Initially light (matches: false)
        expect(screen.getByTestId('theme')).toHaveTextContent('light');

        // Simulate system change to dark
        act(() => {
            if (changeHandler) {
                changeHandler({ matches: true } as MediaQueryListEvent);
            }
        });

        expect(screen.getByTestId('theme')).toHaveTextContent('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('does NOT update on system preference change if user HAS preference', () => {
        localStorage.setItem('theme', 'light');

        let changeHandler: any = null;
        addEventListenerMock.mockImplementation((event, handler) => {
            if (event === 'change') changeHandler = handler;
        });

        render(
            <ThemeProvider>
                <TestComponent />
            </ThemeProvider>
        );

        expect(screen.getByTestId('theme')).toHaveTextContent('light');

        // Simulate system change to dark
        act(() => {
            if (changeHandler) {
                changeHandler({ matches: true } as MediaQueryListEvent);
            }
        });

        // Should still be light because localStorage has 'light'
        expect(screen.getByTestId('theme')).toHaveTextContent('light');
    });

    test('throws error if useTheme used outside provider', () => {
        // Suppress console error for expected throw
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        expect(() => render(<TestComponent />)).toThrow('useTheme must be used within a ThemeProvider');

        consoleSpy.mockRestore();
    });
});
