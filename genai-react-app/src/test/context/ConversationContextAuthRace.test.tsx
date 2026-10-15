import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { ConversationProvider, useConversation } from '../../context/ConversationContext';
import { MemoryRouter } from 'react-router-dom';

// Mutable so each test can model a different point in the login lifecycle
let mockAuthState: any;
jest.mock('../../context/AuthContext', () => ({
    useAuth: () => mockAuthState,
}));

jest.mock('../../context/AIContext', () => ({
    useAI: () => ({
        config: [{ aiVendor: 'OPENAI', model: 'gpt-4' }],
        setSupplementalText: jest.fn(),
        customerInstructions: [],
    }),
}));

jest.mock('../../context/LayoutContext', () => ({
    useLayout: () => ({
        setLeftSidebarExpanded: jest.fn(),
        setRightSidebarExpanded: jest.fn(),
        setLeftSidebarMinimized: jest.fn(),
        setHistoryWidgetExpanded: jest.fn(),
    }),
}));

const mockShowToast = jest.fn();
jest.mock('../../context/ToastContext', () => ({
    useToast: () => ({ showToast: mockShowToast }),
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../services/conversationService', () => ({
    getConversation: jest.fn(),
}));

const TestComponent = () => {
    const { loadConversation } = useConversation();
    return <button onClick={() => loadConversation('conv-403')}>Load</button>;
};

const renderProvider = () =>
    render(
        <MemoryRouter>
            <ConversationProvider>
                <TestComponent />
            </ConversationProvider>
        </MemoryRouter>
    );

const forbidden = () => {
    const err: any = new Error('Failed to fetch conversation: 403 Forbidden');
    err.status = 403;
    return err;
};

// Deep-link login regression (infinite /chat/<id> ⇄ /?code=… loop): right
// after the Auth0 callback the session is live but /onboard hasn't returned
// a customerId yet, so strict isAuthenticated is still false. loadConversation
// must treat that window as logged-in — send the token, and never answer a
// 403 with another loginWithRedirect.
describe('loadConversation during the post-login onboarding window', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('attaches the token and treats a 403 as no-access, not logged-out', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockRejectedValue(forbidden());
        mockAuthState = {
            isAuthenticated: false, // strict: onboard still in flight
            isSessionAuthenticated: true,
            customerId: null,
            loginWithRedirect: jest.fn(),
            logout: jest.fn(),
            getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        };

        renderProvider();
        await act(async () => { screen.getByText('Load').click(); });

        expect(getConversation).toHaveBeenCalledWith('token', 'conv-403');
        expect(mockAuthState.loginWithRedirect).not.toHaveBeenCalled();
        expect(mockShowToast).toHaveBeenCalled();
        expect(mockNavigate).toHaveBeenCalledWith('/chat');
    });

    test('still redirects to login on 403 when there is no Auth0 session', async () => {
        const { getConversation } = require('../../services/conversationService');
        getConversation.mockRejectedValue(forbidden());
        mockAuthState = {
            isAuthenticated: false,
            isSessionAuthenticated: false,
            customerId: null,
            loginWithRedirect: jest.fn(),
            logout: jest.fn(),
            getAccessTokenSilently: jest.fn(),
        };

        renderProvider();
        await act(async () => { screen.getByText('Load').click(); });

        expect(getConversation).toHaveBeenCalledWith('', 'conv-403');
        expect(mockAuthState.loginWithRedirect).toHaveBeenCalledWith({
            appState: { returnTo: window.location.pathname },
        });
        expect(mockShowToast).not.toHaveBeenCalled();
    });
});
