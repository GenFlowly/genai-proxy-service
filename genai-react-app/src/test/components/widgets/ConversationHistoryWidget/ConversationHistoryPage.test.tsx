import React from 'react';
import { render, screen } from '@testing-library/react';
import ConversationHistoryPage from '../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryPage';
import '@testing-library/jest-dom';

jest.mock('../../../../components/navbar/Navbar', () => () => <div data-testid="mock-navbar" />);

// The page must reuse the existing widget component, not duplicate it
jest.mock('../../../../components/widgets/ConversationHistoryWidget/ConversationHistoryComponent', () => () => (
    <div data-testid="mock-conversation-history-component" />
));

describe('ConversationHistoryPage', () => {
    test('renders Navbar and reuses ConversationHistoryComponent', () => {
        render(<ConversationHistoryPage />);

        expect(screen.getByTestId('mock-navbar')).toBeInTheDocument();
        expect(screen.getByTestId('mock-conversation-history-component')).toBeInTheDocument();
    });
});
