import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { RunHitlBanner } from '../../components/widgets/CenterWidgets/ConversationListWidget/RunHitlBanner';

const mockSubmitRunReply = jest.fn();
let mockAwaitingInputs: Record<string, any> = {};

jest.mock('../../context/ConversationContext', () => ({
    useRunHitl: () => ({ awaitingInputs: mockAwaitingInputs, submitRunReply: mockSubmitRunReply }),
}));

describe('RunHitlBanner', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAwaitingInputs = {};
    });

    test('renders nothing when there are no awaiting inputs', () => {
        const { container } = render(<RunHitlBanner />);
        expect(container.firstChild).toBeNull();
    });

    test('renders the run prompt and submits a reply', () => {
        mockAwaitingInputs = { m1: { prompt: 'Approve the plan?', run_id: 'r1' } };
        const { getByText, getByPlaceholderText } = render(<RunHitlBanner />);

        expect(getByText('Approve the plan?')).toBeInTheDocument();
        const input = getByPlaceholderText('Type your reply…') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'yes' } });
        fireEvent.click(getByText('Send'));

        expect(mockSubmitRunReply).toHaveBeenCalledWith('m1', 'yes');
    });

    test('submits on Enter and ignores blank replies', () => {
        mockAwaitingInputs = { m1: { prompt: 'Need input', run_id: 'r1' } };
        const { getByPlaceholderText } = render(<RunHitlBanner />);
        const input = getByPlaceholderText('Type your reply…') as HTMLInputElement;

        // Blank reply does nothing
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockSubmitRunReply).not.toHaveBeenCalled();

        fireEvent.change(input, { target: { value: 'go ahead' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockSubmitRunReply).toHaveBeenCalledWith('m1', 'go ahead');
    });

    test('falls back to a default prompt when none is provided', () => {
        mockAwaitingInputs = { m1: { run_id: 'r1' } };
        const { getByText } = render(<RunHitlBanner />);
        expect(getByText('The assistant needs your input to continue.')).toBeInTheDocument();
    });
});
