import React from 'react'
import ReactDOM from 'react-dom/client'
import { Auth0Provider } from '@auth0/auth0-react'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { config } from './config/env'
import '@genflowly/component-library/dist/main.css'
import './index.css'

// The component library themes via [data-theme] on <html> while this app's
// own styles follow prefers-color-scheme, so mirror the OS scheme onto the
// attribute to keep both in sync.
const scheme = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () =>
    document.documentElement.setAttribute('data-theme', scheme.matches ? 'dark' : 'light')
applyTheme()
scheme.addEventListener('change', applyTheme)

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Auth0Provider
            domain={config.auth0.domain}
            clientId={config.auth0.clientId}
            authorizationParams={{
                redirect_uri: window.location.origin,
                audience: config.auth0.audience,
            }}
            cacheLocation="localstorage"
        >
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </Auth0Provider>
    </React.StrictMode>
)
