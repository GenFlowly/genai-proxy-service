import React from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
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
import ContentRulesPage from './pages/ContentRulesPage/ContentRulesPage'
import BlockedUsersPage from './pages/BlockedUsersPage/BlockedUsersPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage/PrivacyPolicyPage'
import SupportPage from './pages/SupportPage/SupportPage'
import ConversationHistoryPage from './components/widgets/ConversationHistoryWidget/ConversationHistoryPage'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'
import { AiDataConsentScreen } from './components/onboarding/AiDataConsentScreen'
import { AppMenuOverlay } from './components/sections/L1Menu/AppMenuOverlay'
import AppFooter from './components/AppFooter/AppFooter'
import ServiceWorkerUpdateNotifier from './components/common/ServiceWorkerUpdateNotifier/ServiceWorkerUpdateNotifier'

import { AIProvider } from './context/AIContext'
import { ConversationProvider } from './context/ConversationContext'
import { EdgeSwipeProvider } from './context/EdgeSwipeContext'
import { LayoutProvider } from './context/LayoutContext'
import { ToastProvider } from './context/ToastContext'

/** On phones the app's root is the L1 Menu, which AppMenuOverlay shows; desktop has the navbar instead. */
function HomeRoute(): React.ReactElement | null {
    const { isNarrow } = useResponsiveBreakpoints()
    return isNarrow ? null : <Navigate to="/chat" replace />
}

/** Signed out on a phone, an empty chat has nothing to offer: L1 is the landing page. */
function NewChatRoute(): React.ReactElement {
    const { isNarrow } = useResponsiveBreakpoints()
    const { isSessionAuthenticated } = useAuth()
    return isNarrow && !isSessionAuthenticated ? <Navigate to="/" replace /> : <LandingPage />
}

export default function AppContent(): React.ReactElement | null {
    const {
        isLoading, isOnboarding, isAuthenticated, onboardingCompleted, completeOnboarding,
        aiDataConsentRequired, acceptAiDataConsent, logout,
    } = useAuth()
    const { isNarrow } = useResponsiveBreakpoints()
    const navigate = useNavigate()
    const { pathname } = useLocation()
    useDefaultsPrefetch()
    useTapOutsideEndsEditing()

    // The boot splash (public/index.html) covers this until SplashScreenDismisser lifts it.
    if (isLoading) return null

    // The consent screen opens the policy in a new tab of this same session,
    // so the gates below mustn't cover the page it links to.
    const isReadingPolicy = pathname === '/privacy-policy' || pathname === '/content-rules'

    // Before the wizard, whose key checks are the first calls to a provider.
    if (isAuthenticated && !isOnboarding && aiDataConsentRequired && !isReadingPolicy) {
        return (
            <AiDataConsentScreen
                onAgree={acceptAiDataConsent}
                onDecline={() => logout({ returnTo: window.location.origin })}
            />
        )
    }

    // isAuthenticated here is the strict flag (Auth0 session + /onboard success);
    // isOnboarding means the /onboard sync call itself is still in flight — wait
    // for it so the wizard isn't flashed for an account that's already done.
    if (isAuthenticated && !isOnboarding && onboardingCompleted === false && !isReadingPolicy) {
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
                        <EdgeSwipeProvider>
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
                                <Route path="/content-rules" element={<ContentRulesPage />} />
                                <Route path="/blocked-users" element={<ProtectedRoute><BlockedUsersPage /></ProtectedRoute>} />
                            </Routes>
                            <AppMenuOverlay />
                        </EdgeSwipeProvider>
                        {!isNarrow && <AppFooter />}
                    </ConversationProvider>
                </AIProvider>
            </ToastProvider>
        </LayoutProvider>
    )
}
