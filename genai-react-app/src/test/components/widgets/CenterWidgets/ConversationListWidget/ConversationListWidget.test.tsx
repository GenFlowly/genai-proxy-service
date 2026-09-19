import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConversationListWidget from '../../../../../components/widgets/CenterWidgets/ConversationListWidget/ConversationListWidget';
import { useConversation, useConversationUI } from '../../../../../context/ConversationContext';

// Mock dependencies
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../components/widgets/ConversationWidget/ConversationBlock/ConversationBlock', () => ({ id }: any) => (
    <div data-testid={`conversation-block-${id}`}>Block {id}</div>
));

describe('ConversationListWidget', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseConversationUI = useConversationUI as jest.Mock;
    const mockSetActiveViewportItem = jest.fn();
    
    // Setup for IntersectionObserver mocking
    let observerCallback: (entries: any[]) => void;
    const mockObserve = jest.fn();
    const mockDisconnect = jest.fn();

    beforeAll(() => {
        window.IntersectionObserver = class {
            constructor(callback: any) {
                observerCallback = callback;
            }
            observe = mockObserve;
            disconnect = mockDisconnect;
            unobserve = jest.fn();
        } as any;
    });

    afterAll(() => {
        // Restore to whatever was in setupTests.ts (which is just a mock class)
        window.IntersectionObserver = class {
            observe = jest.fn()
            disconnect = jest.fn()
            unobserve = jest.fn()
        } as any;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        // setActiveViewportItem moved to the ConversationUI context
        mockUseConversationUI.mockReturnValue({ setActiveViewportItem: mockSetActiveViewportItem });
        mockUseConversation.mockReturnValue({
            conversationBlockList: [],
            setActiveViewportItem: mockSetActiveViewportItem
        });
    });

    afterEach(() => {
        jest.useRealTimers();
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

    test('sets up IntersectionObserver and sets active viewport item', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{ conversationBlockId: '1' }],
            setActiveViewportItem: mockSetActiveViewportItem
        });

        // Mock document querySelector and querySelectorAll
        const mockCenterSection = document.createElement('div');
        const mockScrollElement = document.createElement('div');
        mockScrollElement.setAttribute('data-block-id', '1');
        mockScrollElement.setAttribute('data-item-type', 'request');
        
        jest.spyOn(document, 'querySelector').mockImplementation((selector) => {
            if (selector === '[data-testid="center-section"]') return mockCenterSection;
            return null;
        });

        jest.spyOn(document, 'querySelectorAll').mockImplementation((selector) => {
            if (selector === '[data-scroll-item="true"]') return [mockScrollElement] as any;
            return [] as any;
        });

        render(<ConversationListWidget />);

        // Fast forward setTimeout
        act(() => {
            jest.advanceTimersByTime(100);
        });

        // window.IntersectionObserver constructor was called, we can verify observe

        expect(mockObserve).toHaveBeenCalledWith(mockScrollElement);

        // Simulate intersecting
        act(() => {
            observerCallback([{
                isIntersecting: true,
                target: mockScrollElement
            }]);
        });

        expect(mockSetActiveViewportItem).toHaveBeenCalledWith({ blockId: '1', type: 'request' });
    });

    test('cleans up IntersectionObserver and timeout on unmount', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{ conversationBlockId: '1' }],
            setActiveViewportItem: mockSetActiveViewportItem
        });

        jest.spyOn(document, 'querySelector').mockReturnValue(document.createElement('div'));

        const { unmount } = render(<ConversationListWidget />);
        
        unmount();
        
        expect(mockDisconnect).toHaveBeenCalled();
        
        // Fast forward should not trigger observe since timeout was cleared
        act(() => {
            jest.advanceTimersByTime(100);
        });
        
        expect(mockObserve).not.toHaveBeenCalled();
    });
});
