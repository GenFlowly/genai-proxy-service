import React from 'react';
import { Auth0Provider } from '@auth0/auth0-react';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import AppContent from './AppContent';
import { config } from "./config/env";

export default function App(): React.ReactElement {
  const { domain, clientId, audience } = config.auth0;

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        audience: audience,
        redirect_uri: window.location.origin,
        scope: "openid profile email offline_access"
      }}
      cacheLocation="localstorage"
      useRefreshTokens={true}
    >
      <ThemeProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ThemeProvider>
    </Auth0Provider>
  );
}