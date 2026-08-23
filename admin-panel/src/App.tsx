import { useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import SystemApiKeysPage from './pages/SystemApiKeysPage'
import InstructionsPage from './pages/InstructionsPage'
import InstructionDetailPage from './pages/InstructionDetailPage'
import { onboardCustomer } from './services/onboardService'

const NAV_ITEMS: { path: string; label: string }[] = [
    { path: '/system-api-keys', label: 'System AI Vendor API Keys' },
    { path: '/instructions', label: 'Instructions' },
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
                <h1>GenFlowly Admin Panel</h1>
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
                <h1>GenFlowly Admin Panel</h1>
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
                <h1>GenFlowly Admin Panel</h1>
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
                        <Route path="/instructions" element={<InstructionsPage />} />
                        <Route path="/instructions/:instructionId" element={<InstructionDetailPage />} />
                        <Route path="*" element={<Navigate to="/system-api-keys" replace />} />
                    </Routes>
                </main>
            </div>
        </div>
    )
}
