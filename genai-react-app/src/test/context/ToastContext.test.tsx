import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from '../../context/ToastContext';

// Mock Toast component to avoid animation timing issues
jest.mock('../../components/common/Toast/Toast', () => ({
    Toast: ({ toast, onRemove }: any) => (
        <div data-testid="toast-item" onClick={() => onRemove(toast.id)}>
            {toast.message}
        </div>
    )
}));

// Test Component
const TestComponent = () => {
    const { showToast } = useToast();

    return (
        <div>
            <button onClick={() => showToast('Success Message', 5000)}>Show Success</button>
            <button onClick={() => showToast('Short Toast', 100)}>Show Short</button>
        </div>
    );
};

describe('ToastContext', () => {
    test('shows toast message in DOM', () => {
        render(
            <ToastProvider>
                <TestComponent />
            </ToastProvider>
        );

        // Initially not visible
        expect(screen.queryByText('Success Message')).not.toBeInTheDocument();

        // Trigger toast
        act(() => {
            screen.getByText('Show Success').click();
        });

        // Visible now
        expect(screen.getByText('Success Message')).toBeInTheDocument();
    });

    test('removes toast message', () => {
        render(
            <ToastProvider>
                <TestComponent />
            </ToastProvider>
        );

        // Show
        act(() => {
            screen.getByText('Show Short').click();
        });
        expect(screen.getByText('Short Toast')).toBeInTheDocument();

        // Click to trigger removal (Mock acts as onRemove caller)
        act(() => {
            screen.getByText('Short Toast').click();
        });

        expect(screen.queryByText('Short Toast')).not.toBeInTheDocument();
    });
});
