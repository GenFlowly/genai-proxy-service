import React from 'react';
import { AuthProvider } from './context/AuthContext';
import AppContent from './AppContent';
import {config} from "./config/env";

export default function App(): React.ReactElement {
    const { domain, clientId, audience } = config.auth0;

  return (
      <AuthProvider domain={domain} clientId={clientId} audience={audience}>
        <AppContent />
      </AuthProvider>
  );
}