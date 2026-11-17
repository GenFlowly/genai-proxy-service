import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
// Component-library styles first so app styles (below) can override them.
import '@genflowly/component-library/dist/main.css';
import './styles/index.scss';
import './i18n';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { LayoutProvider } from "./context/LayoutContext";
import * as serviceWorkerRegistration from './serviceWorkerRegistration';

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);
root.render(
    // Location changes apply in the same render as the state set beside them,
    // as in react-router 6. With transitions, a new chat's conversation id
    // landed one render before its /chat/:id URL, and the chat page took that
    // for New Chat and reset the conversation.
    <BrowserRouter useTransitions={false}>
        <LayoutProvider>
            <App />
        </LayoutProvider>
    </BrowserRouter>
);

reportWebVitals();

// Registered unconditionally at boot (ahead of auth/onboarding gating) so
// precaching starts on first visit; the update-available toast is wired up
// later in AppContent, once ToastProvider exists.
serviceWorkerRegistration.register({
    onUpdate: (registration) => {
        window.dispatchEvent(
            new CustomEvent(serviceWorkerRegistration.SW_UPDATE_AVAILABLE_EVENT, { detail: registration })
        );
    },
});
