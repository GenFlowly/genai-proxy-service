import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Auth0Provider } from '@auth0/auth0-react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@genflowly/component-library';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { queryClient } from './queryClient';
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
    const returnTo = appState?.returnTo || window.location.pathname;
    if (appState?.returnState) navigate(returnTo, { state: appState.returnState });
    else navigate(returnTo);
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
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <ErrorBoundary fallback={<AppCrashedFallback />}>
              <AppContent />
            </ErrorBoundary>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Auth0Provider>
  );
}