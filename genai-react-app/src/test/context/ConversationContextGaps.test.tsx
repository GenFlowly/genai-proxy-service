import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { MemoryRouter } from 'react-router-dom';

// Mocks
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        customerId: 'user-1',
        getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
    }),
}));

jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: [{ aiVendor: 'OPENAI', model: 'gpt-4' }],
        setSupplementalText: jest.fn(),
        customerInstructions: [],
    }),
}));

jest.mock('../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: jest.fn(),
        setRightSidebarExpanded: jest.fn(),
    }),
}));

jest.mock('../../context/ToastContext', () => ({
    useToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('../../services/conversationService', () => ({
    getConversation: jest.fn(),
}));

const TestComponent = () => {
    const { 
        loadConversation, 
        resetConversation, 
        updateResponseInConversationBlock,
        addNewConversationBlockWithId,
        conversationBlockList,
        getSelectedResponseForBlock,
        setSelectedResponseForBlock
    } = useConversation();

    return (
        <div>
            <div data-testid="block-count">{conversationBlockList.length}</div>
            <button onClick={() => loadConversation('fail-id')}>Load Fail</button>
            <button onClick={() => resetConversation()}>Reset</button>
            <button onClick={() => updateResponseInConversationBlock('conv-default', 'new prompt')}>Update Prompt</button>
            <button onClick={() => addNewConversationBlockWithId('manual-id')}>Add Manual</button>
            <button onClick={() => setSelectedResponseForBlock('conv-default', 'msg-123')}>Set Selected</button>
            <div data-testid="selected-res">{getSelectedResponseForBlock('conv-default')}</div>
        </div>
    );
};

describe('ConversationContext Gaps', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        localStorage.clear();
    });

    test('loadConversation handles errors (line 204)', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockRejectedValue(new Error('Fetch Error'));
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        await act(async () => {
            screen.getByText('Load Fail').click();
        });

        expect(consoleSpy).toHaveBeenCalledWith("Failed to load conversation", expect.any(Error));
        consoleSpy.mockRestore();
    });

    test('resetConversation clears user-specific localStorage (lines 214-215)', () => {
        localStorage.setItem('user-1_prompt_editor_content_1', 'some text');
        localStorage.setItem('other_key', 'keep me');

        render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        act(() => {
            screen.getByText('Reset').click();
        });

        expect(localStorage.getItem('user-1_prompt_editor_content_1')).toBeNull();
        expect(localStorage.getItem('other_key')).toBe('keep me');
    });

    test('updateResponseInConversationBlock (line 244)', () => {
        render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        act(() => {
            screen.getByText('Update Prompt').click();
        });
    });

    test('addNewConversationBlockWithId (lines 541-547)', () => {
        render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );

        act(() => {
            screen.getByText('Add Manual').click();
        });

        expect(screen.getByTestId('block-count')).toHaveTextContent('2');
    });

    test('getSelectedResponseForBlock with fallback (line 58)', () => {
        render(
            <MemoryRouter>
                <ConversationProvider>
                    <TestComponent />
                </ConversationProvider>
            </MemoryRouter>
        );
        expect(screen.getByTestId('selected-res')).toHaveTextContent('');
        
        act(() => {
            screen.getByText('Set Selected').click();
        });
        expect(screen.getByTestId('selected-res')).toHaveTextContent('msg-123');
    });
});
