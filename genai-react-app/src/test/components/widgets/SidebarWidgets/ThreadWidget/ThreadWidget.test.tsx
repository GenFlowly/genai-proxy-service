import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
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
                responseMessages: [],
                status: 'draft'
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
                    responseMessages: [{ id: 'res-1' }],
                    status: 'resolved'
                },
                {
                    conversationBlockId: 'block-2',
                    prompt: 'Block 2 Prompt',
                    responseMessages: [],
                    status: 'resolved'
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

        // Block 2: Prompt and empty Response UI hook
        expect(screen.getByTestId('prompt-item-block-2')).toHaveTextContent('Prompt: Block 2 Prompt');
        expect(screen.getByTestId('response-item-block-2')).toBeInTheDocument();
    });

    test('renders collapsed state correctly', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                {
                    conversationBlockId: 'block-1',
                    prompt: 'Prompt',
                    responseMessages: [],
                    status: 'draft'
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

    test('handles scroll events and sets isScrolling state', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                {
                    conversationBlockId: 'block-1',
                    prompt: 'Prompt',
                    responseMessages: [],
                    status: 'resolved'
                }
            ]
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        render(<ThreadWidget />);

        // The thread list container is the one rendered when blocks exist
        // We can find it by getting the parent of the prompt-item, or testid if we had one.
        // Let's add a testid to it or find it by class
        // It has className styles.threadList. Since styles are mocked, we can just find it by traversing up.
        const promptItem = screen.getByTestId('prompt-item-block-1');
        const threadBlock = promptItem.parentElement;
        const threadList = threadBlock?.parentElement;
        
        expect(threadList).toBeInTheDocument();
        
        // Initial state should not have scrolling class
        expect(threadList?.className).not.toMatch(/scrolling/);

        // Fire scroll event
        act(() => {
            fireEvent.scroll(threadList!);
        });

        // Should have scrolling class
        expect(threadList?.className).toMatch(/scrolling/);

        // Fast forward 800ms
        act(() => {
            jest.advanceTimersByTime(800);
        });

        // Scrolling class should be removed
        expect(threadList?.className).not.toMatch(/scrolling/);
    });

    test('cleans up timeout on unmount', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [
                {
                    conversationBlockId: 'block-1',
                    prompt: 'Prompt',
                    responseMessages: [],
                    status: 'resolved'
                }
            ]
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true
        });

        const { unmount } = render(<ThreadWidget />);

        const promptItem = screen.getByTestId('prompt-item-block-1');
        const threadList = promptItem.parentElement?.parentElement;

        act(() => {
            fireEvent.scroll(threadList!);
        });

        // Unmount the component while timer is active
        unmount();

        // If it throws an error or warns about act(), it means the state was updated after unmount
        // Since we clean it up, advancing timers shouldn't cause React state update warnings
        act(() => {
            jest.advanceTimersByTime(800);
        });
    });
});
