import React from 'react'
import ReactDOM from 'react-dom/client'
import { Auth0Provider } from '@auth0/auth0-react'
import App from './App'
import { config } from './config/env'
import './index.css'

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
            <App />
        </Auth0Provider>
    </React.StrictMode>
)
