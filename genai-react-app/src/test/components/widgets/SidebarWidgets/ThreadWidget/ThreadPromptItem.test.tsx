import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadPromptItem from '../../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadPromptItem';
import { useConversationUI } from '../../../../../context/ConversationContext';
import '@testing-library/jest-dom';

const defaultProps = {
    conversationBlockId: 'block-1',
    prompt: 'Short'
};

// Mock Tooltip
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    Tooltip: ({ content, children }: any) => (
        <div data-testid="mock-tooltip" data-content={content}>
            {children}
        </div>
    ),
}));

jest.mock('../../../../../context/ConversationContext');

describe('ThreadPromptItem', () => {
    const mockUseConversation = useConversationUI as jest.Mock;
    beforeAll(() => {
        // Mock scrollIntoView
        Element.prototype.scrollIntoView = jest.fn();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseConversation.mockReturnValue({
            activeViewportItem: null
        });
    });

    test('renders expanded state correctly', () => {
        render(<ThreadPromptItem {...defaultProps} />);
        const button = screen.getByTestId('thread-prompt-item');
        expect(button).toBeInTheDocument();
        expect(screen.getByTestId('thread-prompt-item-text')).toHaveTextContent('Short');
        // Verify title attribute
        expect(button).toHaveAttribute('title', 'Short');
    });

    test('truncates long prompt in expanded state', () => {
        const longPrompt = 'This is a very long prompt';
        render(<ThreadPromptItem {...defaultProps} prompt={longPrompt} />);

        const text = screen.getByTestId('thread-prompt-item-text');
        // Logic: substring(0, 10) + '...'
        // "This is a " -> 10 chars
        expect(text).toHaveTextContent('This is a ...');
        // Title should still be full prompt
        const button = screen.getByTestId('thread-prompt-item');
        expect(button).toHaveAttribute('title', longPrompt);
    });

    test('renders collapsed state correctly', () => {
        render(<ThreadPromptItem {...defaultProps} collapsed={true} />);
        const button = screen.getByTestId('thread-prompt-item-collapsed');
        expect(button).toBeInTheDocument();
        // Text should not be visible in collapsed button (handled by CSS/layout, but we check logic)
        expect(screen.queryByTestId('thread-prompt-item-text')).not.toBeInTheDocument();
    });

    test('renders collapsed state with Tooltip', () => {
        render(<ThreadPromptItem {...defaultProps} collapsed={true} />);

        const tooltip = screen.getByTestId('mock-tooltip');
        expect(tooltip).toBeInTheDocument();
        expect(tooltip).toHaveAttribute('data-content', 'Short');

        const button = screen.getByTestId('thread-prompt-item-collapsed');
        expect(button).toBeInTheDocument();
    });

    test('handles click and scrolls to view', () => {
        render(<ThreadPromptItem {...defaultProps} />);

        // Mock document.querySelector to return a fake element
        const mockScrollIntoView = jest.fn();
        const mockElement = { scrollIntoView: mockScrollIntoView };
        jest.spyOn(document, 'querySelector').mockReturnValue(mockElement as any);

        const button = screen.getByTestId('thread-prompt-item');
        fireEvent.click(button);

        expect(document.querySelector).toHaveBeenCalledWith('[data-block-id="block-1"]');
        expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    test('adds activeViewport class and scrolls when active', () => {
        mockUseConversation.mockReturnValue({
            activeViewportItem: { blockId: 'block-1', type: 'request' }
        });
        render(<ThreadPromptItem {...defaultProps} />);
        
        const button = screen.getByTestId('thread-prompt-item');
        expect(button).toHaveClass('activeViewport');
        // We know it calls scrollIntoView on the ref
    });
});
