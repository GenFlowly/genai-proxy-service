import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Auth0Provider } from '@auth0/auth0-react';
import { ErrorBoundary } from '@genflowly/component-library';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import AppContent from './AppContent';
import { config } from "./config/env";
import { useVisualViewportHeight } from './hooks/useVisualViewportHeight';

/** Last-resort fallback when something throws outside any inner boundary — a blank tab is worse than this. */
function AppCrashedFallback(): React.ReactElement {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <p>Something went wrong. Please reload the page.</p>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

export default function App(): React.ReactElement {
  const { domain, clientId, audience } = config.auth0;
  const navigate = useNavigate();
  useVisualViewportHeight();

  const onRedirectCallback = (appState: any) => {
    navigate(appState?.returnTo || window.location.pathname);
  };

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        audience: audience,
        redirect_uri: window.location.origin,
        scope: "openid profile email offline_access"
      }}
      onRedirectCallback={onRedirectCallback}
      cacheLocation="localstorage"
      useRefreshTokens={true}
      useRefreshTokensFallback={true}
    >
      <ThemeProvider>
        <AuthProvider>
          <ErrorBoundary fallback={<AppCrashedFallback />}>
            <AppContent />
          </ErrorBoundary>
        </AuthProvider>
      </ThemeProvider>
    </Auth0Provider>
  );
}