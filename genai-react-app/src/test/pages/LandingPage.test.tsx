import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LandingPage from '../../pages/LandingPage';
import { ConversationProvider } from '../../context/ConversationContext';

// Mock child components
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/LeftSidebar/LeftSidebar', () => () => <div data-testid="left-sidebar">LeftSidebar</div>);
jest.mock('../../components/sections/RightSidebar/RightSidebar', () => () => <div data-testid="right-sidebar">RightSidebar</div>);
jest.mock('../../components/sections/CenterSection/CenterSection', () => () => <div data-testid="center-section">CenterSection</div>);

// Mock ConversationContext
const mockLoadConversation = jest.fn();
const mockResetConversation = jest.fn();

jest.mock('../../context/ConversationContext', () => ({
    useConversation: () => ({
        conversationId: global.mockContextId, // Dynamic mock based on global var for test setup
        loadConversation: mockLoadConversation,
        resetConversation: mockResetConversation,
    }),
    ConversationProvider: ({ children }: any) => <div>{children}</div>
}));

describe('LandingPage Routing Logic', () => {
    beforeEach(() => {
        // Reset mocks and global state
        mockLoadConversation.mockClear();
        mockResetConversation.mockClear();
        global.mockContextId = null;
    });

    test('Renders all layout components', () => {
        render(
            <MemoryRouter initialEntries={['/chat']}>
                <Routes>
                    <Route path="/chat" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByTestId('left-sidebar')).toBeInTheDocument();
        expect(screen.getByTestId('center-section')).toBeInTheDocument();
        expect(screen.getByTestId('right-sidebar')).toBeInTheDocument();
    });

    test('Loads conversation when URL has ID and context is different', async () => {
        global.mockContextId = null; // Context is empty

        render(
            <MemoryRouter initialEntries={['/chat/123']}>
                <Routes>
                    <Route path="/chat/:conversationId" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(mockLoadConversation).toHaveBeenCalledWith('123');
        });
    });

    test('Does NOT load conversation if context ID matches URL ID', async () => {
        global.mockContextId = '123'; // Context already has this ID

        render(
            <MemoryRouter initialEntries={['/chat/123']}>
                <Routes>
                    <Route path="/chat/:conversationId" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(mockLoadConversation).not.toHaveBeenCalled();
        });
    });

    test('Resets conversation when URL is base /chat but context has ID', async () => {
        global.mockContextId = '123'; // Context has previous chat

        render(
            <MemoryRouter initialEntries={['/chat']}>
                <Routes>
                    <Route path="/chat" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(mockResetConversation).toHaveBeenCalled();
        });
    });
});

// Helper for dynamic mocking
declare global {
    var mockContextId: string | null;
}
