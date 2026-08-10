import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResponseThinking from '../../../../../components/widgets/ConversationWidget/ResponseThinkingWidget/ResponseThinking';
import { Message } from '../../../../../models/conversation.models';
import { AIVendor } from '../../../../../constants/vendors';
import '@testing-library/jest-dom';

const mockSetVendorSelectionForBlock = jest.fn();
let mockSelection: string[] = [];
let mockMaxVendors = 2;

jest.mock('../../../../../context/LayoutContext', () => ({
    useLayout: () => ({ isLeftSidebarExpanded: false, isRightSidebarExpanded: false })
}));

jest.mock('../../../../../context/ConversationContext', () => ({
    useConversation: () => ({
        getVendorSelectionForBlock: () => mockSelection,
        setVendorSelectionForBlock: mockSetVendorSelectionForBlock,
    })
}));

jest.mock('../../../../../hooks/useMaxVendors', () => ({
    useMaxVendors: () => mockMaxVendors
}));

// Render TextContainer synchronously (the real one lazy-loads its core)
jest.mock('../../../../../components/common/TextContainer/TextContainer', () => (props: any) => (
    <div data-testid="text-container">
        {props.title}
        {props.isLoading ? props.loadingContent : <div>{props.content}</div>}
    </div>
));

const makeMessage = (vendor: AIVendor, overrides: Partial<Message> = {}): Message => ({
    aiVendor: vendor,
    text: 'Some response',
    messageId: `msg-${vendor}`,
    thinkingSteps: ['step one'],
    isLoading: false,
    ...overrides,
});

describe('ResponseThinking', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSelection = [];
        mockMaxVendors = 2;
    });

    test('renders nothing when there are no vendors', () => {
        const { container } = render(<ResponseThinking blockId="b1" responseMessages={[]} />);
        expect(container.firstChild).toBeNull();
    });

    test('shows no toggle group for a single vendor', () => {
        render(<ResponseThinking blockId="b1" responseMessages={[makeMessage(AIVendor.OPENAI)]} />);
        expect(screen.queryByTestId('vendor-radio-group')).not.toBeInTheDocument();
        expect(screen.queryByTestId('vendor-checkbox-group')).not.toBeInTheDocument();
    });

    test('shows the checkbox group when vendors fit the column limit', () => {
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[makeMessage(AIVendor.OPENAI), makeMessage(AIVendor.CLAUDE)]}
            />
        );

        expect(screen.getByTestId('vendor-checkbox-group')).toBeInTheDocument();
        expect(screen.queryByTestId('vendor-radio-group')).not.toBeInTheDocument();
    });

    test('shows the radio group when vendors exceed the column limit', () => {
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE, AIVendor.GEMINI];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[
                    makeMessage(AIVendor.OPENAI),
                    makeMessage(AIVendor.CLAUDE),
                    makeMessage(AIVendor.GEMINI),
                ]}
            />
        );

        expect(screen.getByTestId('vendor-radio-group')).toBeInTheDocument();
        expect(screen.queryByTestId('vendor-checkbox-group')).not.toBeInTheDocument();
    });

    test('radio group selection replaces the previous vendor selection', async () => {
        mockSelection = [AIVendor.OPENAI, AIVendor.CLAUDE, AIVendor.GEMINI];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[
                    makeMessage(AIVendor.OPENAI),
                    makeMessage(AIVendor.CLAUDE),
                    makeMessage(AIVendor.GEMINI),
                ]}
            />
        );

        await userEvent.click(screen.getByTestId(`vendor-radio-group-option-${AIVendor.GEMINI}`));

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('b1', [AIVendor.GEMINI]);
    });

    test('checkbox group keeps other selections when below the limit', async () => {
        mockMaxVendors = 3;
        mockSelection = [AIVendor.OPENAI];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[makeMessage(AIVendor.OPENAI), makeMessage(AIVendor.CLAUDE)]}
            />
        );

        await userEvent.click(screen.getByTestId(`vendor-checkbox-group-option-${AIVendor.CLAUDE}`));

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('b1', [AIVendor.OPENAI, AIVendor.CLAUDE]);
    });

    test('auto-selects vendors that appear for the first time', () => {
        mockSelection = [];
        render(<ResponseThinking blockId="b1" responseMessages={[makeMessage(AIVendor.OPENAI)]} />);

        expect(mockSetVendorSelectionForBlock).toHaveBeenCalledWith('b1', [AIVendor.OPENAI]);
    });

    test('renders thinking steps for selected vendors', () => {
        mockSelection = [AIVendor.OPENAI];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[makeMessage(AIVendor.OPENAI, { thinkingSteps: ['pondering deeply'] })]}
            />
        );

        expect(screen.getByTestId('text-container')).toBeInTheDocument();
        expect(screen.getByText('Thinking')).toBeInTheDocument();
    });

    test('shows the thinking placeholder while a vendor is still loading', () => {
        mockSelection = [AIVendor.OPENAI];
        render(
            <ResponseThinking
                blockId="b1"
                responseMessages={[
                    makeMessage(AIVendor.OPENAI, { text: '', isLoading: true, thinkingSteps: [] }),
                ]}
            />
        );

        expect(screen.getByText('Thinking...')).toBeInTheDocument();
    });
});
