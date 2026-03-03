import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Response from '../../../../../components/widgets/ConversationWidget/ResponseWidget/Response';
import { useConversation } from '../../../../../context/ConversationContext';
import { useLayout } from '../../../../../context/LayoutContext';
import { AIVendor } from '../../../../../constants/vendors';
import '@testing-library/jest-dom';

// Mock contexts
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/LayoutContext');

// Mock child components
jest.mock('../../../../../components/common/TextContainer/TextContainer', () => ({ children, title, 'data-testid': testId }: any) => (
    <div data-testid={testId || 'text-container'}>
        <div data-testid="tc-title">{title}</div>
        {children}
    </div>
));

jest.mock('../../../../../components/common/ToggleGroupButton/ToggleGroupButton', () => ({ options }: any) => (
    <div data-testid="toggle-group">
        {options.map((o: any) => <span key={o.id}>{o.label}</span>)}
    </div>
));

jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    OpenAIBrandName: () => <span>OpenAI</span>,
    ClaudeBrandName: () => <span>Claude</span>,
    GeminiBrandName: () => <span>Gemini</span>
}));

jest.mock('../../../../../components/common/MultiPurposeButton/MultiPurposeButton', () => ({ label, onClick, disabled, 'data-testid': testId }: any) => (
    <button data-testid={testId} onClick={onClick} disabled={disabled}>
        {label}
    </button>
));

describe('Response Widget Component', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseLayout = useLayout as jest.Mock;
    const mockSetSelectedResponseForBlock = jest.fn();
    const mockGetSelectedResponseForBlock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockUseConversation.mockReturnValue({
            setSelectedResponseForBlock: mockSetSelectedResponseForBlock,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock
        });
        mockUseLayout.mockReturnValue({
            isLeftSidebarExpanded: true,
            isRightSidebarExpanded: true
        });
        mockGetSelectedResponseForBlock.mockReturnValue(null);
    });

    const mockMessages = [
        { messageId: 'msg-1', text: 'Response 1', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0 },
        { messageId: 'msg-2', text: 'Response 2', aiVendor: AIVendor.CLAUDE, isLoading: false, timestamp: 0 }
    ];

    test('renders nothing if no messages', () => {
        render(<Response blockId="block-1" responseMessages={[]} />);
        expect(screen.queryByTestId('text-container')).not.toBeInTheDocument();
    });

    test('renders messages', () => {
        render(<Response blockId="block-1" responseMessages={mockMessages} data-testid="res-comp" />);
        expect(screen.getByTestId('res-comp')).toBeInTheDocument();
        expect(screen.getAllByTestId('response-message')).toHaveLength(2);
        // Toggle group label + BrandName title = 2
        expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Claude').length).toBeGreaterThanOrEqual(1);
    });

    test('renders ToggleGroup if multiple vendors', () => {
        render(<Response blockId="block-1" responseMessages={mockMessages} />);
        expect(screen.getByTestId('toggle-group')).toBeInTheDocument();
    });

    test('does NOT render ToggleGroup if single vendor', () => {
        const singleMsg = [{ messageId: 'msg-1', text: 'Response 1', aiVendor: AIVendor.OPENAI, isLoading: false, timestamp: 0 }];
        render(<Response blockId="block-1" responseMessages={singleMsg} />);
        expect(screen.queryByTestId('toggle-group')).not.toBeInTheDocument();
    });

    test('handles Follow Up click', () => {
        const onFollowUp = jest.fn();
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={onFollowUp} />);

        const followUpBtns = screen.getAllByTestId('follow-up-button');
        fireEvent.click(followUpBtns[0]); // Click first one

        expect(mockSetSelectedResponseForBlock).toHaveBeenCalledWith('block-1', 'msg-1');
        expect(onFollowUp).toHaveBeenCalledWith('msg-1');
    });

    test('Follow Up button disabled if props.disabled is true', () => {
        const onFollowUp = jest.fn();
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={onFollowUp} disabled={true} />);

        const followUpBtns = screen.getAllByTestId('follow-up-button');
        expect(followUpBtns[0]).toBeDisabled();

        fireEvent.click(followUpBtns[0]);
        expect(onFollowUp).not.toHaveBeenCalled();
    });

    test('Follow Up button indicates "Selected" state', () => {
        mockGetSelectedResponseForBlock.mockReturnValue('msg-1'); // Msg 1 selected
        render(<Response blockId="block-1" responseMessages={mockMessages} onFollowUp={jest.fn()} />);

        const btns = screen.getAllByTestId('follow-up-button'); // use test id to target
        // First button should say 'Selected' and be disabled
        expect(btns[0]).toHaveTextContent('Selected');
        expect(btns[0]).toBeDisabled();

        // Second button should act normal
        expect(btns[1]).toHaveTextContent('Follow up');
        expect(btns[1]).not.toBeDisabled();
    });
    test('does NOT show Follow Up button if content is loading', () => {
        const loadingMsgs = [
            { messageId: 'msg-loading', text: 'Generating...', aiVendor: AIVendor.OPENAI, isLoading: true, timestamp: 0 }
        ];
        render(<Response blockId="block-1" responseMessages={loadingMsgs} onFollowUp={jest.fn()} data-testid="res-comp" />);

        // Should render content but NO follow up button
        expect(screen.getByTestId('res-comp')).toBeInTheDocument();
        expect(screen.queryByTestId('follow-up-button')).not.toBeInTheDocument();
    });

    test('renders token badge when input and output tokens are provided', () => {
        const msgsWithTokens = [
            {
                messageId: 'msg-tokens',
                text: 'Here is a response',
                aiVendor: AIVendor.OPENAI,
                isLoading: false,
                inputTokens: 1234,
                outputTokens: 567
            }
        ];
        render(<Response blockId="block-1" responseMessages={msgsWithTokens} onFollowUp={jest.fn()} />);

        // Check if both token counts are rendered
        expect(screen.getByTitle('Input tokens')).toHaveTextContent('1,234');
        expect(screen.getByTitle('Output tokens')).toHaveTextContent('567');
    });

    test('does not render token badge when tokens are null or undefined', () => {
        const msgsWithoutTokens = [
            {
                messageId: 'msg-no-tokens',
                text: 'Here is a response without tokens',
                aiVendor: AIVendor.OPENAI,
                isLoading: false
            }
        ];
        render(<Response blockId="block-1" responseMessages={msgsWithoutTokens} onFollowUp={jest.fn()} />);

        // Check if token titles are ABSENT
        expect(screen.queryByTitle('Input tokens')).not.toBeInTheDocument();
        expect(screen.queryByTitle('Output tokens')).not.toBeInTheDocument();
    });
});
