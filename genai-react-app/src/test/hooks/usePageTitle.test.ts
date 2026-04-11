import { renderHook } from '@testing-library/react';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useLocation, useParams } from 'react-router-dom';
import { useSidebarMenu } from '../../context/SidebarMenuContext';

// Mock dependencies
jest.mock('react-router-dom', () => ({
    useLocation: jest.fn(),
    useParams: jest.fn(),
}));

jest.mock('../../context/SidebarMenuContext', () => ({
    useSidebarMenu: jest.fn(),
}));

describe('usePageTitle Hook', () => {
    const DEFAULT_TITLE = 'Genflowly';

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset document title before each test
        document.title = DEFAULT_TITLE;
    });

    test('sets "New Conversation" title for empty chat route', () => {
        (useLocation as jest.Mock).mockReturnValue({ pathname: '/chat' });
        (useParams as jest.Mock).mockReturnValue({}); // No conversationId
        (useSidebarMenu as jest.Mock).mockReturnValue({ activeWidgetId: null });

        renderHook(() => usePageTitle());

        expect(document.title).toBe(`New Conversation | ${DEFAULT_TITLE}`);
    });

    test('does NOT overwrite title for active conversation route', () => {
        (useLocation as jest.Mock).mockReturnValue({ pathname: '/chat/123' });
        (useParams as jest.Mock).mockReturnValue({ conversationId: '123' });
        (useSidebarMenu as jest.Mock).mockReturnValue({ activeWidgetId: null });

        const customTitle = 'Custom Conversation Title | Genflowly';
        document.title = customTitle;

        renderHook(() => usePageTitle());

        // Should NOT have reverted to DEFAULT_TITLE
        expect(document.title).toBe(customTitle);
    });

    test('sets "Memory" title for memory route', () => {
        (useLocation as jest.Mock).mockReturnValue({ pathname: '/memory' });
        (useParams as jest.Mock).mockReturnValue({});
        (useSidebarMenu as jest.Mock).mockReturnValue({ activeWidgetId: null });

        renderHook(() => usePageTitle());

        expect(document.title).toBe(`Memory | ${DEFAULT_TITLE}`);
    });

    test('sets "AI Vendor API Keys Settings" title for vendor settings widget', () => {
        (useLocation as jest.Mock).mockReturnValue({ pathname: '/settings' });
        (useParams as jest.Mock).mockReturnValue({});
        (useSidebarMenu as jest.Mock).mockReturnValue({ 
            activeWidgetId: 'CONFIGURE_AI_VENDOR_SETTINGS' 
        });

        renderHook(() => usePageTitle());

        expect(document.title).toBe(`AI Vendor API Keys Settings | ${DEFAULT_TITLE}`);
    });

    test('sets "Database Settings" title for database settings widget', () => {
        (useLocation as jest.Mock).mockReturnValue({ pathname: '/settings' });
        (useParams as jest.Mock).mockReturnValue({});
        (useSidebarMenu as jest.Mock).mockReturnValue({ 
            activeWidgetId: 'DATABASE_CONNECTIONS_SETTINGS' 
        });

        renderHook(() => usePageTitle());

        expect(document.title).toBe(`Database Settings | ${DEFAULT_TITLE}`);
    });
});
