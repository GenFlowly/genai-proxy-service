import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import LandingPage from '../../pages/LandingPage';
import { ConversationProvider } from '../../context/ConversationContext';

// Mock child components
jest.mock('../../components/navbar/Navbar', () => () => <div data-testid="navbar">Navbar</div>);
jest.mock('../../components/sections/ChatSidebar/ChatSidebar', () => () => <div data-testid="chat-sidebar">ChatSidebar</div>);
jest.mock('../../components/sections/AiSettingsDock/AiSettingsDock', () => () => <div data-testid="ai-settings-dock">AiSettingsDock</div>);
jest.mock('../../components/sections/CenterSection/CenterSection', () => ({ widgetIds }: any) => <div data-testid="center-section" data-widget-ids={JSON.stringify(widgetIds)}>CenterSection</div>);
jest.mock('../../components/widgets/ConversationHeader/ConversationHeader', () => () => <div data-testid="conversation-header">ConversationHeader</div>);

// Mock Config
jest.mock('../../config/PageWidgetConfig', () => ({
    getPageConfig: jest.fn(),
    getPageIdFromPath: jest.fn()
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

// Mock react-router to spy on hooks
jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    useLocation: jest.fn(),
    useParams: jest.fn()
}));
const mockUseLocation = jest.requireMock('react-router').useLocation;
const mockUseParams = jest.requireMock('react-router').useParams;

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
        mockUseLocation.mockImplementation(() => jest.requireActual('react-router').useLocation());
        mockUseParams.mockImplementation(() => jest.requireActual('react-router').useParams());
    });

    test('pins residual window scroll to 0 on mount and on pageshow', () => {
        const scrollToSpy = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
        // Simulate iOS leaving the window force-scrolled from a previous
        // keyboard session (restored by bfcache/history restoration)
        Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 120 });

        render(
            <MemoryRouter initialEntries={['/chat']}>
                <Routes>
                    <Route path="/chat" element={<LandingPage />} />
                </Routes>
            </MemoryRouter>
        );
        expect(scrollToSpy).toHaveBeenCalledWith(0, 0);

        // Coming back from bfcache re-pins too
        scrollToSpy.mockClear();
        window.dispatchEvent(new Event('pageshow'));
        expect(scrollToSpy).toHaveBeenCalledWith(0, 0);

        // Already at 0 → no redundant scroll
        scrollToSpy.mockClear();
        (window as any).scrollY = 0;
        window.dispatchEvent(new Event('pageshow'));
        expect(scrollToSpy).not.toHaveBeenCalled();

        scrollToSpy.mockRestore();
        (window as any).scrollY = 0;
    });

    const renderChat = (path = '/chat') => render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/chat" element={<LandingPage />} />
                <Route path="/chat/:conversationId" element={<LandingPage />} />
            </Routes>
        </MemoryRouter>
    );

    const setWidth = (width: number) => {
        act(() => {
            Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
            window.dispatchEvent(new Event('resize'));
        });
    };

    afterEach(() => setWidth(1280));

    test('desktop: navbar, sidebar, the sub-bar inside the main panel, and the dock', () => {
        renderChat();

        expect(screen.getByTestId('navbar')).toBeInTheDocument();
        expect(screen.getByTestId('chat-sidebar')).toBeInTheDocument();
        expect(screen.getByTestId('ai-settings-dock')).toBeInTheDocument();

        const main = screen.getByRole('main');
        expect(main).toContainElement(screen.getByTestId('conversation-header'));
        expect(main).toContainElement(screen.getByTestId('center-section'));
        expect(screen.getByTestId('center-section')).toHaveAttribute('data-widget-ids', '["CENTER"]');
    });

    test('phone: no navbar or sidebar; the header overlays the conversation', () => {
        renderChat();
        setWidth(600);

        expect(screen.queryByTestId('navbar')).not.toBeInTheDocument();
        expect(screen.queryByTestId('chat-sidebar')).not.toBeInTheDocument();
        expect(screen.queryByRole('main')).not.toBeInTheDocument();
        expect(screen.getByTestId('conversation-header')).toBeInTheDocument();
        expect(screen.getByTestId('center-section')).toBeInTheDocument();
        // The AI Settings modal lives in the dock component on phones too
        expect(screen.getByTestId('ai-settings-dock')).toBeInTheDocument();
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
