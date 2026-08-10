import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage/SettingsPage'
import MemoryPage from './pages/MemoryPage/MemoryPage'
import AgentsPage from './pages/AgentsPage/AgentsPage'
import EditAgentPage from './pages/AgentsPage/EditAgentPage/EditAgentPage'
import InstructionsPage from './pages/InstructionsPage/InstructionsPage'
import InstructionDetailPage from './pages/InstructionDetailPage/InstructionDetailPage'
import ConversationHistoryPage from './components/widgets/ConversationHistoryWidget/ConversationHistoryPage'
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
                            <Route path="/chat">
                                <Route index element={<LandingPage />} />
                                <Route path=":conversationId" element={<LandingPage />} />
                            </Route>
                            <Route path="/settings/*" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
                            <Route path="/history" element={<ProtectedRoute><ConversationHistoryPage /></ProtectedRoute>} />
                            <Route path="/memory" element={<ProtectedRoute><MemoryPage /></ProtectedRoute>} />
                            <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
                            <Route path="/agents/:graphId" element={<ProtectedRoute><EditAgentPage /></ProtectedRoute>} />
                            <Route path="/instructions" element={<InstructionsPage />} />
                            <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                        </Routes>
                    </ConversationProvider>
                </AIProvider>
            </ToastProvider>
        </LayoutProvider>
    )
}
