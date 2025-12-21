import React from 'react'
import { Routes, Route } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage'

import { AIProvider } from './context/AIContext'
import { ConversationProvider } from './context/ConversationContext'
import { LayoutProvider } from './context/LayoutContext'

export default function AppContent(): React.ReactElement {
    const { isLoading } = useAuth()

    if (isLoading) return <div>Loading...</div>

    return (
        <LayoutProvider>
            <AIProvider>
                <ConversationProvider>
                    <Routes>
                        <Route path="/" element={<LandingPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                    </Routes>
                </ConversationProvider>
            </AIProvider>
        </LayoutProvider>
    )
}
