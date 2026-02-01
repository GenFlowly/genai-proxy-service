import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConversationListWidget from '../../../../../components/widgets/CenterWidgets/ConversationListWidget/ConversationListWidget';
import { useConversation } from '../../../../../context/ConversationContext';

// Mock dependencies
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../components/widgets/ConversationWidget/ConversationBlock/ConversationBlock', () => ({ id }: any) => (
    <div data-testid={`conversation-block-${id}`}>Block {id}</div>
));

describe('ConversationListWidget', () => {
    const mockUseConversation = useConversation as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders nothing when list is empty', () => {
        mockUseConversation.mockReturnValue({ conversationBlockList: [] });
        const { container } = render(<ConversationListWidget />);
        expect(container).toBeEmptyDOMElement();
    });

    test('renders conversation blocks', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                { conversationBlockId: '1' },
                { conversationBlockId: '2' }
            ]
        });

        render(<ConversationListWidget />);

        expect(screen.getByTestId('conversation-block-1')).toBeInTheDocument();
        expect(screen.getByTestId('conversation-block-2')).toBeInTheDocument();
    });
});
