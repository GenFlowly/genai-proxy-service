import React from 'react';
import { render, screen } from '@testing-library/react';
import ThreadWidget from '../../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadWidget';
import { useConversation } from '../../../../../context/ConversationContext';
import { useLayout } from '../../../../../context/LayoutContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/LayoutContext');
jest.mock('../../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadPromptItem', () => ({ conversationBlockId, prompt, collapsed }: any) => (
    <div data-testid={`prompt-item-${conversationBlockId}`}>
        Prompt: {prompt} {collapsed ? '(Collapsed)' : ''}
    </div>
));
jest.mock('../../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadResponseItem', () => ({ conversationBlockId, responseCount, collapsed }: any) => (
    <div data-testid={`response-item-${conversationBlockId}`}>
        Responses: {responseCount} {collapsed ? '(Collapsed)' : ''}
    </div>
));

describe('ThreadWidget', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseLayout = useLayout as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders empty state correctly (Expanded)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: []
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        render(<ThreadWidget />);

        expect(screen.getByTestId('thread-widget')).toBeInTheDocument();
        expect(screen.getByText('Thread')).toBeInTheDocument();
        expect(screen.getByTestId('thread-empty-state')).toHaveTextContent('No conversation yet');
    });

    test('renders empty state when block is empty (Initial load)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'init-block',
                prompt: '',
                responseMessages: []
            }]
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        render(<ThreadWidget />);
        expect(screen.getByTestId('thread-empty-state')).toBeInTheDocument();
    });

    test('renders thread items correctly (Expanded)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                {
                    conversationBlockId: 'block-1',
                    prompt: 'Block 1 Prompt',
                    responseMessages: [{ id: 'res-1' }]
                },
                {
                    conversationBlockId: 'block-2',
                    prompt: 'Block 2 Prompt',
                    responseMessages: []
                }
            ]
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        render(<ThreadWidget />);

        // Block 1: Both prompt and response
        expect(screen.getByTestId('prompt-item-block-1')).toHaveTextContent('Prompt: Block 1 Prompt');
        expect(screen.getByTestId('response-item-block-1')).toHaveTextContent('Responses: 1');

        // Block 2: Only prompt
        expect(screen.getByTestId('prompt-item-block-2')).toHaveTextContent('Prompt: Block 2 Prompt');
        expect(screen.queryByTestId('response-item-block-2')).not.toBeInTheDocument();
    });

    test('renders collapsed state correctly', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                {
                    conversationBlockId: 'block-1',
                    prompt: 'Prompt',
                    responseMessages: []
                }
            ]
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: false
        });

        render(<ThreadWidget />);

        // Should not see title or empty state text
        expect(screen.queryByText('Thread')).not.toBeInTheDocument();

        // Items should receive collapsed prop
        expect(screen.getByTestId('prompt-item-block-1')).toHaveTextContent('(Collapsed)');
    });
});
