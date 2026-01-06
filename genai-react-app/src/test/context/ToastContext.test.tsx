import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../../context/ToastContext';

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
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

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


});
