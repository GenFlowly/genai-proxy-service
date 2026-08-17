import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import NewChatWidget from '../../../../../components/widgets/SidebarWidgets/NewChatWidget/NewChatWidget';
import { useSidebarWidget } from '../../../../../hooks/useSidebarWidget';
import '@testing-library/jest-dom';

// Mocks
jest.mock('../../../../../hooks/useSidebarWidget');

jest.mock('../../../../../components/common/SidebarWidgetContainer/SidebarWidgetContainer', () =>
    ({ children, collapsedContent, 'data-testid': testId }: any) => (
        <div data-testid={testId}>
            <div data-testid="widget-collapsed-content">{collapsedContent}</div>
            <div data-testid="widget-content">{children}</div>
        </div>
    )
);

jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    PillButton: ({ label, onClick, 'data-testid': testId }: any) => (
        <button data-testid={testId} onClick={onClick}>
            {label}
        </button>
    ),
}));

describe('NewChatWidget', () => {
    const mockUseSidebarWidget = useSidebarWidget as jest.Mock;
    const mockResetConversation = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseSidebarWidget.mockReturnValue({
            conversation: {
                resetConversation: mockResetConversation
            }
        });
    });

    test('renders correctly', () => {
        render(<NewChatWidget />);
        expect(screen.getByTestId('new-chat-widget')).toBeInTheDocument();
        expect(screen.getByTestId('new-chat-button-expanded')).toBeInTheDocument();
        expect(screen.getByTestId('new-chat-button-collapsed')).toBeInTheDocument();
    });

    test('calls resetConversation when expanded button is clicked', () => {
        render(<NewChatWidget />);
        fireEvent.click(screen.getByTestId('new-chat-button-expanded'));
        expect(mockResetConversation).toHaveBeenCalledTimes(1);
    });

    test('calls resetConversation when collapsed button is clicked', () => {
        render(<NewChatWidget />);
        fireEvent.click(screen.getByTestId('new-chat-button-collapsed'));
        expect(mockResetConversation).toHaveBeenCalledTimes(1);
    });
});
