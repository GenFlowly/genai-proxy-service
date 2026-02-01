import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LandingPage from '../../pages/LandingPage';
import { ConversationProvider } from '../../context/ConversationContext';

// Mock child components
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/LeftSidebar/LeftSidebar', () => ({ widgetIds }: any) => <div data-testid="left-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>LeftSidebar</div>);
jest.mock('../../components/sections/RightSidebar/RightSidebar', () => ({ widgetIds }: any) => <div data-testid="right-sidebar" data-widget-ids={JSON.stringify(widgetIds)}>RightSidebar</div>);
jest.mock('../../components/sections/CenterSection/CenterSection', () => ({ widgetIds }: any) => <div data-testid="center-section" data-widget-ids={JSON.stringify(widgetIds)}>CenterSection</div>);

// Mock Config
jest.mock('../../config/PageWidgetConfig', () => ({
    getPageConfig: jest.fn(),
    getPageIdFromPath: jest.fn() // if used or mocked by usage
}));
const mockGetPageConfig = jest.requireMock('../../config/PageWidgetConfig').getPageConfig;

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

// Mock react-router-dom to spy on hooks
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useLocation: jest.fn(),
    useParams: jest.fn()
}));
const mockUseLocation = jest.requireMock('react-router-dom').useLocation;
const mockUseParams = jest.requireMock('react-router-dom').useParams;

describe('LandingPage Routing Logic', () => {
    beforeEach(() => {
        // Reset mocks and global state
        mockLoadConversation.mockClear();
        mockResetConversation.mockClear();
        global.mockContextId = null;

        mockGetPageConfig.mockReturnValue({
            pageId: 'CHAT_PAGE',
            leftSidebar: ['LEFT'],
            centerSection: ['CENTER'],
            rightSidebar: ['RIGHT']
        });

        // Default behavior: use actual implementation
        mockUseLocation.mockImplementation(() => jest.requireActual('react-router-dom').useLocation());
        mockUseParams.mockImplementation(() => jest.requireActual('react-router-dom').useParams());
    });

    test('Renders all layout components with correct widget IDs', () => {
        render(
            <MemoryRouter initialEntries={['/chat']}>
                <Routes>
                    <Route path="/chat" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByTestId('navbar')).toBeInTheDocument();

        const left = screen.getByTestId('left-sidebar');
        expect(left).toBeInTheDocument();
        expect(left).toHaveAttribute('data-widget-ids', '["LEFT"]');

        const center = screen.getByTestId('center-section');
        expect(center).toBeInTheDocument();
        expect(center).toHaveAttribute('data-widget-ids', '["CENTER"]');

        const right = screen.getByTestId('right-sidebar');
        expect(right).toBeInTheDocument();
        expect(right).toHaveAttribute('data-widget-ids', '["RIGHT"]');
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

    test('Resets conversation when URL is /chat/ (trailing slash)', async () => {
        global.mockContextId = '123';

        render(
            <MemoryRouter initialEntries={['/chat/']}>
                <Routes>
                    <Route path="/chat" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(mockResetConversation).toHaveBeenCalled();
        });
    });

    test('Does NOT load conversation if routeId does not match location pathname (prevent race condition)', async () => {
        global.mockContextId = null;

        // Mock hooks to simulate mismatch
        // Route ID says '123', but Pathname is '/chat/456'
        mockUseParams.mockReturnValue({ conversationId: '123' });
        mockUseLocation.mockReturnValue({ pathname: '/chat/456' });

        render(
            <LandingPage />
        );

        await waitFor(() => {
            // Just wait a tick to ensure effect runs
            expect(mockLoadConversation).not.toHaveBeenCalled();
        });
    });
});

// Helper for dynamic mocking
declare global {
    var mockContextId: string | null;
}
