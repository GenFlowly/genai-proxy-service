import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Request from '../../../../../components/widgets/ConversationWidget/RequestWidget/Request';
import { useConversation } from '../../../../../context/ConversationContext';
import { useAuth } from '../../../../../context/AuthContext';
import '@testing-library/jest-dom';

// Mock contexts
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/AuthContext');

// Mock child components
jest.mock('../../../../../components/widgets/PromptEditorWidget/PromptEditor', () => ({
    value,
    onChange,
    'data-testid': testId
}: any) => (
    <textarea
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
    />
));

jest.mock('../../../../../components/common/TextContainer/TextContainer', () => ({ content }: { content: string }) => (
    <div data-testid="text-container">{content}</div>
));

jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    UserBrandName: () => <span data-testid="user-brand-name">User</span>
}));

describe('Request Widget Component', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseAuth = useAuth as jest.Mock;
    const mockGenerateResponsesStream = jest.fn();
    const mockSetEditorPrompt = jest.fn();
    const mockSetActiveBlockId = jest.fn();
    const mockGetSelectedResponseForBlock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: false,
                prompt: ''
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });

        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: true }],
            customerName: 'Test User',
            user: { name: 'Auth0 User' },
            customerId: 'cust-123'
        });
    });

    test('renders in Editor mode when no responses', () => {
        render(<Request blockId="block-1" data-testid="request-comp" />);
        expect(screen.getByTestId('request-comp')).toBeInTheDocument();
        expect(screen.getByTestId('prompt-editor')).toBeInTheDocument();
        expect(screen.getByTestId('generate-button')).toBeInTheDocument();
    });

    test('renders in Reader mode when has responses and not loading', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [{ id: 'res-1' }],
                isLoading: false,
                prompt: 'Resolved Prompt'
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });

        render(<Request blockId="block-1" data-testid="request-comp" />);
        expect(screen.getByTestId('request-comp')).toBeInTheDocument();
        // Should show resolved content
        expect(screen.getByTestId('text-container')).toHaveTextContent('Resolved Prompt');
        // Editor and button should NOT be there
        expect(screen.queryByTestId('prompt-editor')).not.toBeInTheDocument();
    });

    test('handles focus and typing (Active state)', () => {
        // use fake timers for debounce
        jest.useFakeTimers();

        render(<Request blockId="block-1" />);
        const editor = screen.getByTestId('prompt-editor');

        // Test Focus (implicit by typing)
        editor.focus();
        expect(editor).toHaveFocus();

        // Typing updates local state and calls context update (after debounce)
        fireEvent.change(editor, { target: { value: 'New Prompt' } });
        expect(editor).toHaveValue('New Prompt'); // Local state update

        // Check context update
        act(() => {
            jest.advanceTimersByTime(500); // Debounce time
        });

        expect(mockSetActiveBlockId).toHaveBeenCalledWith('block-1');
        expect(mockSetEditorPrompt).toHaveBeenCalledWith('New Prompt');

        jest.useRealTimers();
    });

    test('handles Clicked state (Generate button)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: false,
                prompt: 'Ready Prompt'
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });
        mockGetSelectedResponseForBlock.mockReturnValue('selected-res-id');

        render(<Request blockId="block-1" />);
        const btn = screen.getByTestId('generate-button');

        fireEvent.click(btn);

        expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', 'Ready Prompt', 'selected-res-id');
    });

    test('disable Generate button if API key invalid', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: false }],
            customerName: 'Test User'
        });

        render(<Request blockId="block-1" />);
        const btn = screen.getByTestId('generate-button');

        expect(btn).toBeDisabled();

        fireEvent.click(btn);
        expect(mockGenerateResponsesStream).not.toHaveBeenCalled();
    });

    test('sets Active Block on mount if empty', () => {
        render(<Request blockId="block-1" />);
        expect(mockSetActiveBlockId).toHaveBeenCalledWith('block-1');
    });

    test('loads draft from localStorage on mount', () => {
        const storageKey = 'cust-123_prompt_editor_content_conv-block-1';
        localStorage.setItem(storageKey, 'Restored Draft');

        render(<Request blockId="block-1" />);
        const editor = screen.getByTestId('prompt-editor');

        expect(editor).toHaveValue('Restored Draft');

        // Clean up
        localStorage.removeItem(storageKey);
    });
});
