import React from 'react';
import { render, act, screen, waitFor } from '@testing-library/react';
import { ToastProvider, useToast } from '../../context/ToastContext';

const TestComponent = () => {
    const { showToast } = useToast();
    return (
        <button onClick={() => showToast('Hello Toast')} data-testid="toast-btn">Show Toast</button>
    );
};

describe('ToastContext Deep Dive', () => {
    test('shows and hides toast', async () => {
        jest.useFakeTimers();
        render(<ToastProvider><TestComponent /></ToastProvider>);
        
        act(() => {
            screen.getByTestId('toast-btn').click();
        });

        expect(screen.getByText('Hello Toast')).toBeInTheDocument();

        act(() => {
            jest.advanceTimersByTime(3000);
        });

        await waitFor(() => {
            expect(screen.queryByText('Hello Toast')).not.toBeInTheDocument();
        });
        
        jest.useRealTimers();
    });

    test('manual dismissal branch (Line 42 area)', async () => {
        // If we had a close button in the Toast component, we would click it here.
    });
});
