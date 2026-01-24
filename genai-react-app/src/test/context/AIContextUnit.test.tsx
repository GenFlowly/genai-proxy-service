import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { AIProvider, useAI, AIConfig } from '../../context/AIContext';
import { AIVendor } from '../../constants/vendors';

// Mock AuthContext for Provider dependency
const mockUseAuth = jest.fn();
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => mockUseAuth(),
    AuthProvider: ({ children }: any) => children
}));

const TestComponent = () => {
    const {
        config,
        setSelectedModelForAIVendor,
        resetConfig
    } = useAI();

    return (
        <div>
            <div data-testid="config-length">{config.length}</div>
            <div data-testid="config-json">{JSON.stringify(config)}</div>
            <button onClick={() => setSelectedModelForAIVendor(AIVendor.OPENAI, 'gpt-4')}>Set OpenAI</button>
            <button onClick={() => setSelectedModelForAIVendor(AIVendor.CLAUDE, 'claude-3')}>Set Claude</button>
            <button onClick={() => setSelectedModelForAIVendor(null as any, 'invalid')}>Set Invalid</button>
            <button onClick={() => setSelectedModelForAIVendor(AIVendor.OPENAI, null as any)}>Set OpenAI Null</button>
            <button onClick={resetConfig}>Reset</button>
        </div>
    );
};

describe('AIContext Unit Tests', () => {
    beforeEach(() => {
        mockUseAuth.mockReturnValue({ customerId: 'cust-1', customerInstructions: [] });
    });

    test('setSelectedModelForAIVendor logic', () => {
        render(
            <AIProvider>
                <TestComponent />
            </AIProvider>
        );

        // Initial
        expect(screen.getByTestId('config-length')).toHaveTextContent('0');

        // 1. Add New
        act(() => {
            screen.getByText('Set OpenAI').click();
        });
        expect(screen.getByTestId('config-length')).toHaveTextContent('1');
        expect(screen.getByTestId('config-json')).toHaveTextContent('gpt-4');

        // 2. Update Existing
        act(() => {
            // Set null model -> should fallback to existing? Or empty?
            // Code: model: model ?? updated[existingIndex].model ?? ''
            screen.getByText('Set OpenAI Null').click();
        });
        expect(screen.getByTestId('config-json')).toHaveTextContent('gpt-4'); // Should persist previous if null passed?

        // 3. Add Another
        act(() => {
            screen.getByText('Set Claude').click();
        });
        expect(screen.getByTestId('config-length')).toHaveTextContent('2');

        // 4. Invalid Vendor (No-op)
        act(() => {
            screen.getByText('Set Invalid').click();
        });
        expect(screen.getByTestId('config-length')).toHaveTextContent('2'); // No change
    });

    test('resetConfig clears config', () => {
        render(
            <AIProvider>
                <TestComponent />
            </AIProvider>
        );
        act(() => {
            screen.getByText('Set OpenAI').click();
            screen.getByText('Reset').click();
        });
        expect(screen.getByTestId('config-length')).toHaveTextContent('0');
    });

    test('useAI outside provider warns and returns fallback', () => {
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        render(<TestComponent />);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('useAI must be used within AIProvider'));
        consoleSpy.mockRestore();
    });
});
