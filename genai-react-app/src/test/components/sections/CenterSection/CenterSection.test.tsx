import React from 'react';
import { render, screen } from '@testing-library/react';
import CenterSection from '../../../../components/sections/CenterSection/CenterSection';
import { useConversation } from '../../../../context/ConversationContext';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../context/ConversationContext');

jest.mock('../../../../components/widgets/InstructionWidget/InstructionWidget', () => () => (
    <div data-testid="instruction-widget-mock">Instruction Widget</div>
));

jest.mock('../../../../components/widgets/ConversationWidget/ConversationBlock/ConversationBlock', () => ({ id }: any) => (
    <div data-testid={`conversation-block-${id}`}>Block {id}</div>
));

describe('CenterSection', () => {
    const mockUseConversation = useConversation as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders correctly (Empty Conversation)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: []
        });

        render(<CenterSection />);

        expect(screen.getByTestId('center-section')).toBeInTheDocument();
        expect(screen.getByTestId('center-section-content')).toBeInTheDocument();
        expect(screen.getByTestId('instruction-widget-mock')).toBeInTheDocument();

        // No blocks
        const blocks = screen.queryAllByTestId(/^conversation-block-/);
        expect(blocks).toHaveLength(0);
    });

    test('renders conversation blocks correctly', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                { conversationBlockId: 'block-1' },
                { conversationBlockId: 'block-2' }
            ]
        });

        render(<CenterSection />);

        expect(screen.getByTestId('instruction-widget-mock')).toBeInTheDocument();

        expect(screen.getByTestId('conversation-block-block-1')).toBeInTheDocument();
        expect(screen.getByTestId('conversation-block-block-2')).toBeInTheDocument();

        const blocks = screen.getAllByTestId(/^conversation-block-/);
        expect(blocks).toHaveLength(2);
    });

    test('renders instruction widget scroll anchor', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: []
        });

        const { container } = render(<CenterSection />);
        // Checking for ID explicitly if needed, although styling check is tricky in jsdom
        const anchor = container.querySelector('#instruction-widget-scroll-anchor');
        expect(anchor).toBeInTheDocument();
        expect(anchor).toHaveStyle('width: 100%');
    });
});
