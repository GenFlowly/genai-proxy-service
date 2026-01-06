import React from 'react';
import { render, screen, act } from '@testing-library/react';
import ConversationBlock from '../../../../../components/widgets/ConversationWidget/ConversationBlock/ConversationBlock';
import { useConversation } from '../../../../../context/ConversationContext';
import { useAuth } from '../../../../../context/AuthContext';
import '@testing-library/jest-dom';

// Mock contexts
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/AuthContext');

// Mock child components to verify props and existence
jest.mock('../../../../../components/widgets/ConversationWidget/RequestWidget/Request', () => ({ blockId }: { blockId: string }) => (
    <div data-testid={`mock-request-${blockId}`}>Request: {blockId}</div>
));

jest.mock('../../../../../components/widgets/ConversationWidget/ResponseWidget/Response', () => ({
    blockId,
    onFollowUp,
    disabled
}: {
    blockId: string,
    onFollowUp: (id: string) => void,
    disabled: boolean
}) => (
    <div data-testid={`mock-response-${blockId}`}>
        Response: {blockId}
        <button data-testid="follow-up-btn" onClick={() => onFollowUp('msg-1')} disabled={disabled}>Follow Up</button>
    </div>
));

describe('ConversationBlock Component', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseAuth = useAuth as jest.Mock;
    const mockAddNewConversationBlockWithId = jest.fn();
    const mockSetSelectedResponseForBlock = jest.fn();

    const mockScrollIntoView = jest.fn();

    beforeAll(() => {
        Element.prototype.scrollIntoView = mockScrollIntoView;
        HTMLElement.prototype.scrollIntoView = mockScrollIntoView;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: false
            }],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: true }]
        });
    });

    test('renders Request widget always', () => {
        render(<ConversationBlock id="block-1" data-testid="conv-block" />);
        expect(screen.getByTestId('conv-block')).toBeInTheDocument();
        expect(screen.getByTestId('mock-request-block-1')).toBeInTheDocument();
    });

    test('does not render Response widget if no messages', () => {
        render(<ConversationBlock id="block-1" />);
        expect(screen.queryByTestId('mock-response-block-1')).not.toBeInTheDocument();
    });

    test('renders Response widget if messages exist', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [{ id: 'msg-1', content: 'Hello' }],
                isLoading: false
            }],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });

        render(<ConversationBlock id="block-1" />);
        expect(screen.getByTestId('mock-response-block-1')).toBeInTheDocument();
    });

    test('disables Response actions if no valid API key', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: false }]
        });
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [{ id: 'msg-1' }],
                isLoading: false
            }],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });

        render(<ConversationBlock id="block-1" />);
        const btn = screen.getByTestId('follow-up-btn');
        expect(btn).toBeDisabled();
    });

    test('handleFollowUp reuses last empty block', async () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                { conversationBlockId: 'block-1', responseMessages: [{ id: 'msg-1' }] },
                { conversationBlockId: 'block-2', responseMessages: [] } // Last block is empty
            ],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });

        render(<ConversationBlock id="block-1" />);

        const btn = screen.getByTestId('follow-up-btn');
        act(() => {
            btn.click();
        });

        expect(mockSetSelectedResponseForBlock).toHaveBeenCalledWith('block-2', 'msg-1');
        expect(mockAddNewConversationBlockWithId).not.toHaveBeenCalled();
    });

    test('handleFollowUp creates new block if last block has content', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                { conversationBlockId: 'block-1', responseMessages: [{ id: 'msg-1' }] } // Last block has content
            ],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });

        render(<ConversationBlock id="block-1" />);

        const btn = screen.getByTestId('follow-up-btn');
        act(() => {
            btn.click();
        });

        expect(mockAddNewConversationBlockWithId).toHaveBeenCalled();
    });

    test('scrolls to response on mount if messages exist', () => {
        jest.useFakeTimers();
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [{ id: 'msg-1' }],
                isLoading: false
            }],
            addNewConversationBlockWithId: mockAddNewConversationBlockWithId,
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock
        });

        render(<ConversationBlock id="block-1" />);

        act(() => {
            jest.advanceTimersByTime(200);
        });

        expect(mockScrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
        jest.useRealTimers();
    });
});
