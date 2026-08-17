import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// Component-library styles first so app styles (below) can override them.
import '@genflowly/component-library/dist/main.css';
import './styles/index.scss';
import './i18n';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { LayoutProvider } from "./context/LayoutContext";

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);
root.render(
    <BrowserRouter>
        <LayoutProvider>
            <App />
        </LayoutProvider>
    </BrowserRouter>
);

reportWebVitals();
