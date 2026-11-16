// jest-dom adds custom jest matchers for asserting on DOM nodes.
import '@testing-library/jest-dom';
// Initialize i18next so components using useTranslation render real English strings in tests.
import '../i18n';
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

console.log('!!! SETUP TESTS RUNNING !!!');

// jsdom's default viewport is 1024x768 — exactly at the isNarrow breakpoint
// (useResponsiveBreakpoints), which flips every page into mobile/narrow
// chrome unless a test opts in to a width. Default to a comfortably-desktop
// size instead; tests that need mobile/narrow override window.innerWidth
// explicitly (see LayoutContext.test.tsx).
Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 });

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
    nickname: "test-user",
    name: "Test User",
    picture: "https://example.com/avatar.png",
    updated_at: "2026-01-04T22:25:23.343Z",
    iss: "https://dev-abh5z7416lwy3xhv.us.auth0.com/",
    sub: "auth0|test-user",
    email: "test.user@example.com"
};

const ACCESS_TOKEN = "test-access-token";

const mockLoginWithRedirect = jest.fn();
const mockLogout = jest.fn();
const mockGetAccessTokenSilently = jest.fn().mockResolvedValue(ACCESS_TOKEN);

// Mock Auth0
jest.mock('@auth0/auth0-react', () => ({
    Auth0Provider: ({ children }) => children,
    useAuth0: () => ({
        isAuthenticated: true,
        user: MOCK_USER,
        isLoading: false,
        loginWithRedirect: mockLoginWithRedirect,
        logout: mockLogout,
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

// react-markdown/@uiw/@codemirror mocks removed: those packages moved into
// @genflowly/component-library, whose published bundle is plain CJS (no ESM
// parse issues) and is mocked per-test where needed.

// react-query batches state notifications on a macrotask scheduler, which
// `await act(...)` never flushes — queries would resolve but components
// wouldn't re-render inside tests. A synchronous scheduler keeps the
// pre-react-query test timing semantics.
import { notifyManager } from '@tanstack/react-query'
notifyManager.setScheduler((cb) => cb())
