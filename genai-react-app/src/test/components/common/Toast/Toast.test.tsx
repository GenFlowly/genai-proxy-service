import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { Toast } from '../../../../components/common/Toast/Toast';
import '@testing-library/jest-dom';

describe('Toast Component', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        act(() => {
            jest.runOnlyPendingTimers();
        });
        jest.useRealTimers();
    });

    const mockOnRemove = jest.fn();
    const defaultToast = {
        id: 'toast-1',
        message: 'Test Message',
        duration: 2000
    };

    test('renders with message', () => {
        render(
            <Toast
                toast={defaultToast}
                onRemove={mockOnRemove}
                data-testid="test-toast"
            />
        );

        const toast = screen.getByTestId('test-toast');
        expect(toast).toBeInTheDocument();
        expect(toast).toHaveTextContent('Test Message');
        expect(toast).toHaveAttribute('role', 'status');
    });

    test('calls onRemove after duration + animation time', () => {
        render(
            <Toast
                toast={defaultToast}
                onRemove={mockOnRemove}
                data-testid="test-toast"
            />
        );

        // Fast-forward past the duration (2000ms)
        act(() => {
            jest.advanceTimersByTime(2000);
        });

        // Should be exiting but not removed yet (animation takes 300ms)
        // Note: we can't easily check 'exiting' state without coupling to class name, 
        // but mockOnRemove should NOT have been called yet.
        expect(mockOnRemove).not.toHaveBeenCalled();

        // Fast-forward past animation (300ms)
        act(() => {
            jest.advanceTimersByTime(300);
        });

        expect(mockOnRemove).toHaveBeenCalledTimes(1);
        expect(mockOnRemove).toHaveBeenCalledWith('toast-1');
    });

    test('uses default duration if not provided', () => {
        const noDurationToast = { id: 'toast-2', message: 'Default Duration' };
        render(
            <Toast
                toast={noDurationToast}
                onRemove={mockOnRemove}
                data-testid="test-toast"
            />
        );

        // Default duration is usually 3000ms
        act(() => {
            jest.advanceTimersByTime(3000);
        });

        expect(mockOnRemove).not.toHaveBeenCalled();

        // + 300ms animation
        act(() => {
            jest.advanceTimersByTime(300);
        });

        expect(mockOnRemove).toHaveBeenCalledTimes(1);
    });

    test('cleans up timers on unmount', () => {
        const { unmount } = render(
            <Toast
                toast={defaultToast}
                onRemove={mockOnRemove}
                data-testid="test-toast"
            />
        );

        unmount();

        // Advance time - should not crash or call onRemove
        act(() => {
            jest.advanceTimersByTime(5000);
        });

        expect(mockOnRemove).not.toHaveBeenCalled();
    });
});
