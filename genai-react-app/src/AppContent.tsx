import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from './context/AuthContext'
import { useDefaultsPrefetch } from './hooks/useDefaultsPrefetch'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage/SettingsPage'
import MemoryPage from './pages/MemoryPage/MemoryPage'
import AgentsPage from './pages/AgentsPage/AgentsPage'
import GraphAgentEditorPage from './pages/AgentsPage/GraphAgentEditorPage/GraphAgentEditorPage'
import InstructionsPage from './pages/InstructionsPage/InstructionsPage'
import InstructionDetailPage from './pages/InstructionDetailPage/InstructionDetailPage'
import ConversationHistoryPage from './components/widgets/ConversationHistoryWidget/ConversationHistoryPage'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'

import { AIProvider } from './context/AIContext'
import { ConversationProvider } from './context/ConversationContext'
import { LayoutProvider } from './context/LayoutContext'
import { ToastProvider } from './context/ToastContext'

export default function AppContent(): React.ReactElement {
    const { t } = useTranslation()
    const { isLoading, isOnboarding, isAuthenticated, onboardingCompleted, completeOnboarding } = useAuth()
    useDefaultsPrefetch()

    if (isLoading) return <div>{t("layout.appContent.loading")}</div>

    // isAuthenticated here is the strict flag (Auth0 session + /onboard success);
    // isOnboarding means the /onboard sync call itself is still in flight — wait
    // for it so the wizard isn't flashed for an account that's already done.
    if (isAuthenticated && !isOnboarding && onboardingCompleted === false) {
        return <OnboardingWizard onDone={completeOnboarding} />
    }

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
                            <Route path="/agents/new" element={<ProtectedRoute><GraphAgentEditorPage /></ProtectedRoute>} />
                            <Route path="/agents/:graphId" element={<ProtectedRoute><GraphAgentEditorPage /></ProtectedRoute>} />
                            <Route path="/instructions" element={<InstructionsPage />} />
                            <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                        </Routes>
                    </ConversationProvider>
                </AIProvider>
            </ToastProvider>
        </LayoutProvider>
    )
}
