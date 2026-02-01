import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage'
import MemoryPage from './pages/MemoryPage/MemoryPage'
import { ProtectedRoute } from './components/auth/ProtectedRoute'

import { AIProvider } from './context/AIContext'
import { ConversationProvider } from './context/ConversationContext'
import { LayoutProvider } from './context/LayoutContext'
import { ToastProvider } from './context/ToastContext'

export default function AppContent(): React.ReactElement {
    const { isLoading } = useAuth()

    if (isLoading) return <div>Loading...</div>

    return (
        <LayoutProvider>
            <ToastProvider>
                <AIProvider>
                    <ConversationProvider>
                        <Routes>
                            <Route path="/" element={<Navigate to="/chat" replace />} />
                            <Route path="/chat" element={<LandingPage />} />
                            <Route
                                path="/chat/:conversationId"
                                element={
                                    <ProtectedRoute>
                                        <LandingPage />
                                    </ProtectedRoute>
                                }
                            />
                            <Route path="/settings" element={<SettingsPage />} />
                            <Route path="/memory" element={<MemoryPage />} />
                        </Routes>
                    </ConversationProvider>
                </AIProvider>
            </ToastProvider>
        </LayoutProvider>
    )
}
