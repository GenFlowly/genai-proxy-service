import React, { useEffect, useCallback } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { onboardCustomer } from './services/userSyncService';
import LandingPage from './pages/LandingPage';
import SettingsPage from './pages/SettingsPage';

export default function AppContent(): React.ReactElement {
    const { isLoading, isAuthenticated, user, getAccessTokenSilently } = useAuth();

    const handleUserSync = useCallback(async () => {
        if (!isAuthenticated || !user) return;

        try {
            const token = await getAccessTokenSilently();
            await onboardCustomer(user, token);
        } catch (error) {
            console.error('Failed to sync user with backend:', error);
        }
    }, [isAuthenticated, user, getAccessTokenSilently]);

    useEffect(() => {
        handleUserSync();
    }, [handleUserSync]);

    // Optionally show nothing or a simple inline message during loading
    if (isLoading) return <div>Loading...</div>;

    return (
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
        </Routes>
    );
}
