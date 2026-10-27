import { useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import SystemApiKeysPage from './pages/SystemApiKeysPage'
import InstructionsPage from './pages/InstructionsPage'
import InstructionDetailPage from './pages/InstructionDetailPage'
import DefaultAgentsPage from './pages/DefaultAgentsPage'
import DefaultGraphPage from './pages/DefaultGraphPage'
import AgentGraphEditorPage from './pages/AgentGraphEditorPage'
import RequestAgentsPage from './pages/RequestAgentsPage'
import NodePresetsPage from './pages/NodePresetsPage'
import VendorAllowlistPage from './pages/VendorAllowlistPage'
import UsageRateCardPage from './pages/UsageRateCardPage'
import { onboardCustomer } from './services/onboardService'

const NAV_ITEMS: { path: string; label: string }[] = [
    { path: '/system-api-keys', label: 'System AI Vendor API Keys' },
    { path: '/vendor-allowlist', label: 'Allowlist AI Vendors' },
    { path: '/instructions', label: 'Instructions' },
    { path: '/default-agents', label: 'Default Agents' },
    { path: '/mappings', label: 'Default Actions Mapping' },
    { path: '/node-presets', label: 'Node Presets' },
    { path: '/usage-rate-card', label: 'Cost and Usage Rate Card' },
]

export default function App() {
    const { isAuthenticated, isLoading, error, loginWithRedirect, logout, user, getAccessTokenSilently } = useAuth0()
    const [onboarded, setOnboarded] = useState(false)
    const [onboardError, setOnboardError] = useState<string | null>(null)
    const onboardStartedRef = useRef(false)

    // The admin allowlist matches the DDB profile email, so make sure this
    // account has a profile before any page hits an authenticated endpoint
    useEffect(() => {
        if (!isAuthenticated || !user || onboardStartedRef.current) return
        onboardStartedRef.current = true
        void (async () => {
            try {
                const token = await getAccessTokenSilently()
                await onboardCustomer(token, user)
            } catch (e) {
                setOnboardError(e instanceof Error ? e.message : 'Onboarding failed')
            } finally {
                setOnboarded(true)
            }
        })()
    }, [isAuthenticated, user, getAccessTokenSilently])

    if (isLoading) {
        return <div className="centered">Loading…</div>
    }

    if (error) {
        return (
            <div className="centered">
                <h1>AI Proxy Admin Panel</h1>
                <div className="banner error">Sign-in failed: {error.message}</div>
                <button
                    className="primary"
                    onClick={() => {
                        // Drop any stale Auth0 transaction/cache before retrying
                        Object.keys(localStorage)
                            .filter((k) => k.startsWith('a0.spajs') || k.startsWith('@@auth0'))
                            .forEach((k) => localStorage.removeItem(k))
                        // Clearing local state isn't enough after access_denied:
                        // the rejected account's SSO session cookie survives at
                        // the Auth0 tenant, so a plain retry silently reuses it
                        // and is denied again. End the Auth0 session so the next
                        // sign-in shows a fresh account prompt.
                        logout({ logoutParams: { returnTo: window.location.origin } })
                    }}
                >
                    Sign in with a different account
                </button>
            </div>
        )
    }

    if (!isAuthenticated) {
        return (
            <div className="centered">
                <h1>AI Proxy Admin Panel</h1>
                <p>Internal tool — sign in to continue.</p>
                <button className="primary" onClick={() => loginWithRedirect()}>
                    Sign in
                </button>
            </div>
        )
    }

    if (!onboarded) {
        return <div className="centered">Preparing your account…</div>
    }

    return (
        <div className="app">
            <header className="app-header">
                <h1>AI Proxy Admin Panel</h1>
                <div className="user-info">
                    <span>{user?.email}</span>
                    <button
                        onClick={() =>
                            logout({ logoutParams: { returnTo: window.location.origin } })
                        }
                    >
                        Sign out
                    </button>
                </div>
            </header>
            <div className="app-body">
                <nav className="sidebar">
                    {NAV_ITEMS.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </nav>
                <main>
                    {onboardError && (
                        <div className="banner error">
                            Account sync failed: {onboardError} — some actions may not work.
                        </div>
                    )}
                    <Routes>
                        <Route path="/system-api-keys" element={<SystemApiKeysPage />} />
                        <Route path="/vendor-allowlist" element={<VendorAllowlistPage />} />
                        <Route path="/instructions" element={<InstructionsPage />} />
                        <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                        <Route path="/default-agents" element={<DefaultAgentsPage />} />
                        <Route path="/default-agents/default-graph" element={<DefaultGraphPage />} />
                        <Route path="/default-agents/agent/:graphId" element={<AgentGraphEditorPage />} />
                        <Route path="/mappings" element={<RequestAgentsPage />} />
                        <Route path="/default-agents/mappings" element={<Navigate to="/mappings" replace />} />
                        <Route path="/node-presets" element={<NodePresetsPage />} />
                        <Route path="/usage-rate-card" element={<UsageRateCardPage />} />
                        <Route path="/request-agents" element={<Navigate to="/default-agents" replace />} />
                        <Route path="/default-graph" element={<Navigate to="/default-agents" replace />} />
                        <Route path="*" element={<Navigate to="/system-api-keys" replace />} />
                    </Routes>
                </main>
            </div>
        </div>
    )
}
