import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import './styles/index.scss';
import App from './App';
import reportWebVitals from './reportWebVitals';
import {ConversationProvider} from "./context/ConversationContext";
import {AIProvider} from "./context/AIContext";
import {AuthProvider} from "./context/AuthContext";
import {LayoutProvider} from "./context/LayoutContext";

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);
root.render(
    <React.StrictMode>
        <BrowserRouter>
            <LayoutProvider>
                <App/>
            </LayoutProvider>

        </BrowserRouter>
    </React.StrictMode>
);

reportWebVitals();
