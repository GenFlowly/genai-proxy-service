// jest-dom adds custom jest matchers for asserting on DOM nodes.
import '@testing-library/jest-dom';
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder as any;
global.TextDecoder = TextDecoder as any;

console.log('!!! SETUP TESTS RUNNING !!!');

// Mock matchMedia
window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    // Mock Onboarding Service


    addListener: () => { },
    removeListener: () => { },
    addEventListener: () => { },
    removeEventListener: () => { },
    dispatchEvent: () => true,
});

// Mock IntersectionObserver
class IntersectionObserver {
    observe = jest.fn()
    disconnect = jest.fn()
    unobserve = jest.fn()
}
Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    configurable: true,
    value: IntersectionObserver,
});

class ResizeObserver {
    observe = jest.fn()
    disconnect = jest.fn()
    unobserve = jest.fn()
}

Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserver,
});

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = jest.fn();

// Global Auth0 Mock
// This ensures components that useAuth0 don't crash in tests.
// Individual test files can override this mock if they need specific states.
const MOCK_USER = {
    nickname: "nkirit",
    name: "Neel",
    picture: "https://avatars.githubusercontent.com/u/7536192?v=4",
    updated_at: "2026-01-04T22:25:23.343Z",
    iss: "https://dev-abh5z7416lwy3xhv.us.auth0.com/",
    sub: "github|7536192",
    email: "neel@example.com"
};

const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InpqYUNCU1ZmUE84bk80NmZ0Q0VrSCJ9...";

const mockLoginWithRedirect = jest.fn();
const mockLogout = jest.fn();
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue(ACCESS_TOKEN);

// Mock Auth0
jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }: any) => children,
    useAuth0: () => ({
        isAuthenticated: true,
        user: MOCK_USER,
        isLoading: false,
        loginWithRedirect: mockLoginWithRedirect,
        logout: mockLogout,
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

// Mock react-markdown and plugins to avoid ESM syntax errors in Jest
jest.mock('react-markdown', () => (props: any) => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'markdown-mock' }, props.children)
})
jest.mock('remark-gfm', () => () => { })
jest.mock('rehype-highlight', () => () => { })

jest.mock('@uiw/react-markdown-editor', () => (props: any) => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'markdown-editor-mock' }, props.children)
})

jest.mock('@codemirror/view', () => ({
    EditorView: {
        lineWrapping: {},
        theme: jest.fn(),
        updateListener: { of: jest.fn() }
    },
    keymap: { of: jest.fn() }
}))
jest.mock('@codemirror/state', () => ({
    EditorState: {
        create: jest.fn()
    }
}))
jest.mock('@codemirror/lang-markdown', () => ({}))


