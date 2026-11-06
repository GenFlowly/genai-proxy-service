import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// variables prefixed with 'mock' are allowed in jest.mock
const mockNavigate = jest.fn();

jest.mock('../config/env', () => ({
    config: {
        auth0: { domain: 'd', clientId: 'c', audience: 'a' },
        backend: { baseUrl: 'b' }
    }
}));

// We use a local variable to capture the callback
let capturedOnRedirect: any = null;

jest.mock('@auth0/auth0-react', () => {
    const React = require('react');
    return {
        Auth0Provider: (props: any) => {
            capturedOnRedirect = props.onRedirectCallback;
            return React.createElement('div', null, props.children);
        },
        useAuth0: () => ({
            isAuthenticated: true,
            user: { name: 'Test User' },
            getAccessTokenSilently: jest.fn().mockResolvedValue('token'),
        }),
    };
});

jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

// Mock providers to avoid complexity
jest.mock('../context/AuthContext', () => ({
  AuthProvider: ({ children }: any) => children,
  useAuth: () => ({ isLoading: false }),
}));
jest.mock('../context/ThemeContext', () => ({ ThemeProvider: ({ children }: any) => children }));
jest.mock('../AppContent', () => () => null);

import App from '../App';

describe('App Redirection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        capturedOnRedirect = null;
    });

    test('onRedirectCallback navigates to returnTo if provided', () => {
        render(
            <MemoryRouter>
                <App />
            </MemoryRouter>
        );
        
        expect(capturedOnRedirect).toBeDefined();
        
        act(() => {
            capturedOnRedirect({ returnTo: '/custom-path' });
        });
        
        expect(mockNavigate).toHaveBeenCalledWith('/custom-path');
    });

    test('onRedirectCallback passes returnState on as location state', () => {
        render(
            <MemoryRouter>
                <App />
            </MemoryRouter>
        );

        act(() => {
            capturedOnRedirect({ returnTo: '/chat', returnState: { openMobileMenu: true } });
        });

        expect(mockNavigate).toHaveBeenCalledWith('/chat', { state: { openMobileMenu: true } });
    });

    test('onRedirectCallback navigates to current pathname if returnTo is missing', () => {
        render(
            <MemoryRouter>
                <App />
            </MemoryRouter>
        );
        
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            writable: true,
            value: { ...originalLocation, pathname: '/current-path' },
        });

        act(() => {
            capturedOnRedirect({});
        });
        
        expect(mockNavigate).toHaveBeenCalledWith('/current-path');

        Object.defineProperty(window, 'location', {
            configurable: true,
            value: originalLocation,
        });
    });
});
