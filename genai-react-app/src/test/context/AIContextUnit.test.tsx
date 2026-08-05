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

    test('setSelectedModelForAIVendor logic with fallbacks', () => {
        render(
            <AIProvider>
                <TestComponent />
            </AIProvider>
        );

        // 1. Add New
        act(() => { screen.getByText('Set OpenAI').click(); });
        expect(screen.getByTestId('config-json')).toHaveTextContent('gpt-4');

        // 2. Update Existing with Null (should use fallback logic)
        act(() => { screen.getByText('Set OpenAI Null').click(); });
        // The code: model: model ?? updated[existingIndex].model ?? ''
        // If we call with model=null, it should keep 'gpt-4'
        expect(screen.getByTestId('config-json')).toHaveTextContent('gpt-4');

        // 3. Clear and add new with null model
        act(() => { screen.getByText('Reset').click(); });
        act(() => { screen.getByText('Set OpenAI Null').click(); });
        // In "add new" branch: model: model ?? ''
        // If model is null, should be ''
        expect(screen.getByTestId('config-json')).toHaveTextContent('""');
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
// Trigger coverage run
