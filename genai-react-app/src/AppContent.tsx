import React from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useDefaultsPrefetch } from './hooks/useDefaultsPrefetch'
import { useTapOutsideEndsEditing } from './hooks/useTapOutsideEndsEditing'
import { useResponsiveBreakpoints } from './hooks/useResponsiveBreakpoints'
import { OPEN_L2_MENU_STATE } from './hooks/useAppMenu'
import LandingPage from './pages/LandingPage'
import SettingsPage from './pages/SettingsPage/SettingsPage'
import MemoryPage from './pages/MemoryPage/MemoryPage'
import MemoryDetailPage from './pages/MemoryPage/MemoryDetailPage'
import MemoryEditPage from './pages/MemoryPage/MemoryEditPage'
import MemoryHistoryPage from './pages/MemoryPage/MemoryHistoryPage'
import MemoryUsedInPage from './pages/MemoryPage/MemoryUsedInPage'
import NewMemoryPage from './pages/MemoryPage/NewMemoryPage'
import AgentsPage from './pages/AgentsPage/AgentsPage'
import GraphAgentEditorPage from './pages/AgentsPage/GraphAgentEditorPage/GraphAgentEditorPage'
import InstructionsPage from './pages/InstructionsPage/InstructionsPage'
import InstructionDetailPage from './pages/InstructionDetailPage/InstructionDetailPage'
import InstructionEditPage from './pages/InstructionDetailPage/InstructionEditPage'
import InstructionHistoryPage from './pages/InstructionDetailPage/InstructionHistoryPage'
import InstructionUsedInPage from './pages/InstructionDetailPage/InstructionUsedInPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage/PrivacyPolicyPage'
import SupportPage from './pages/SupportPage/SupportPage'
import ConversationHistoryPage from './components/widgets/ConversationHistoryWidget/ConversationHistoryPage'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'
import { L1Menu } from './components/sections/L1Menu/L1Menu'
import { AppMenuOverlay } from './components/sections/L1Menu/AppMenuOverlay'
import AppFooter from './components/AppFooter/AppFooter'
import ServiceWorkerUpdateNotifier from './components/common/ServiceWorkerUpdateNotifier/ServiceWorkerUpdateNotifier'

import { AIProvider } from './context/AIContext'
import { ConversationProvider } from './context/ConversationContext'
import { LayoutProvider } from './context/LayoutContext'
import { ToastProvider } from './context/ToastContext'

/** On phones the app's root is the L1 Menu; desktop has the navbar instead. */
function HomeRoute(): React.ReactElement {
    const { isNarrow } = useResponsiveBreakpoints()
    return isNarrow ? <L1Menu /> : <Navigate to="/chat" replace />
}

/** Signed out on a phone, an empty chat has nothing to offer: L1 is the landing page. */
function NewChatRoute(): React.ReactElement {
    const { isNarrow } = useResponsiveBreakpoints()
    const { isSessionAuthenticated } = useAuth()
    return isNarrow && !isSessionAuthenticated ? <Navigate to="/" replace /> : <LandingPage />
}

export default function AppContent(): React.ReactElement | null {
    const { isLoading, isOnboarding, isAuthenticated, onboardingCompleted, completeOnboarding } = useAuth()
    const { isNarrow } = useResponsiveBreakpoints()
    const navigate = useNavigate()
    useDefaultsPrefetch()
    useTapOutsideEndsEditing()

    // The boot splash (public/index.html) covers this until SplashScreenDismisser lifts it.
    if (isLoading) return null

    // isAuthenticated here is the strict flag (Auth0 session + /onboard success);
    // isOnboarding means the /onboard sync call itself is still in flight — wait
    // for it so the wizard isn't flashed for an account that's already done.
    if (isAuthenticated && !isOnboarding && onboardingCompleted === false) {
        const finishOnboarding = async () => {
            await completeOnboarding()
            if (isNarrow) navigate('/chat', { state: OPEN_L2_MENU_STATE })
        }
        return <OnboardingWizard onDone={finishOnboarding} />
    }

    return (
        <LayoutProvider>
            <ToastProvider>
                <ServiceWorkerUpdateNotifier />
                <AIProvider>
                    <ConversationProvider>
                        <Routes>
                            <Route path="/" element={<HomeRoute />} />
                            <Route path="/chat">
                                <Route index element={<NewChatRoute />} />
                                <Route path=":conversationId" element={<LandingPage />} />
                            </Route>
                            <Route path="/settings/*" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
                            <Route path="/history" element={<ProtectedRoute><ConversationHistoryPage /></ProtectedRoute>} />
                            <Route path="/memory" element={<ProtectedRoute><MemoryPage /></ProtectedRoute>} />
                            <Route path="/memory/new" element={<ProtectedRoute><NewMemoryPage /></ProtectedRoute>} />
                            <Route path="/memory/:memoryId" element={<ProtectedRoute><MemoryDetailPage /></ProtectedRoute>} />
                            <Route path="/memory/:memoryId/edit" element={<ProtectedRoute><MemoryEditPage /></ProtectedRoute>} />
                            <Route path="/memory/:memoryId/history" element={<ProtectedRoute><MemoryHistoryPage /></ProtectedRoute>} />
                            <Route path="/memory/:memoryId/usage" element={<ProtectedRoute><MemoryUsedInPage /></ProtectedRoute>} />
                            <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
                            <Route path="/agents/new" element={<ProtectedRoute><GraphAgentEditorPage /></ProtectedRoute>} />
                            <Route path="/agents/:graphId" element={<ProtectedRoute><GraphAgentEditorPage /></ProtectedRoute>} />
                            <Route path="/instructions" element={<InstructionsPage />} />
                            <Route path="/instructions/new" element={<InstructionEditPage isNew />} />
                            <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                            <Route path="/instructions/:instructionId/edit" element={<InstructionEditPage />} />
                            <Route path="/instructions/:instructionId/history" element={<InstructionHistoryPage />} />
                            <Route path="/instructions/:instructionId/usage" element={<InstructionUsedInPage />} />
                            <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
                            <Route path="/support" element={<SupportPage />} />
                        </Routes>
                        <AppMenuOverlay />
                        {!isNarrow && <AppFooter />}
                    </ConversationProvider>
                </AIProvider>
            </ToastProvider>
        </LayoutProvider>
    )
}
