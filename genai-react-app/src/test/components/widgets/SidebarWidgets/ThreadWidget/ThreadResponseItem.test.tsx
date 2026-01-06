import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadResponseItem from '../../../../../components/widgets/SidebarWidgets/ThreadWidget/ThreadResponseItem';
import '@testing-library/jest-dom';

describe('ThreadResponseItem', () => {
    const defaultProps = {
        conversationBlockId: 'block-1',
        responseCount: 1
    };

    beforeAll(() => {
        // Mock scrollIntoView
        Element.prototype.scrollIntoView = jest.fn();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('renders expanded state correctly (Single Response)', () => {
        render(<ThreadResponseItem {...defaultProps} />);
        const button = screen.getByTestId('thread-response-item');
        expect(button).toBeInTheDocument();
        expect(screen.getByTestId('thread-response-item-text')).toHaveTextContent('Response');
    });

    test('renders expanded state correctly (Multiple Responses)', () => {
        render(<ThreadResponseItem {...defaultProps} responseCount={5} />);
        expect(screen.getByTestId('thread-response-item-text')).toHaveTextContent('Responses');
    });

    test('renders collapsed state correctly', () => {
        render(<ThreadResponseItem {...defaultProps} collapsed={true} />);
        const button = screen.getByTestId('thread-response-item-collapsed');
        expect(button).toBeInTheDocument();
        // Should have title attribute
        expect(button).toHaveAttribute('title', 'Response');
    });

    test('handles click and scrolls to view', () => {
        render(<ThreadResponseItem {...defaultProps} />);

        // Mock document.querySelector
        const mockScrollIntoView = jest.fn();
        const mockElement = { scrollIntoView: mockScrollIntoView };
        jest.spyOn(document, 'querySelector').mockReturnValue(mockElement as any);

        const button = screen.getByTestId('thread-response-item');
        fireEvent.click(button);

        // Logic uses [data-response-block-id]
        expect(document.querySelector).toHaveBeenCalledWith('[data-response-block-id="block-1"]');
        expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });
});
