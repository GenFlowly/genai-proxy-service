import { useEffect, useRef, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import SystemApiKeysPage from './pages/SystemApiKeysPage'
import InstructionsPage from './pages/InstructionsPage'
import { onboardCustomer } from './services/onboardService'

type PageId = 'SYSTEM_API_KEYS' | 'INSTRUCTIONS'

const NAV_ITEMS: { id: PageId; label: string }[] = [
    { id: 'SYSTEM_API_KEYS', label: 'System AI Vendor API Keys' },
    { id: 'INSTRUCTIONS', label: 'Instructions' },
]

export default function App() {
    const { isAuthenticated, isLoading, error, loginWithRedirect, logout, user, getAccessTokenSilently } = useAuth0()
    const [page, setPage] = useState<PageId>('SYSTEM_API_KEYS')
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
                        window.location.assign(window.location.origin)
                    }}
                >
                    Reset and try again
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
                        <button
                            key={item.id}
                            className={`nav-item ${page === item.id ? 'active' : ''}`}
                            onClick={() => setPage(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
                <main>
                    {onboardError && (
                        <div className="banner error">
                            Account sync failed: {onboardError} — some actions may not work.
                        </div>
                    )}
                    {page === 'SYSTEM_API_KEYS' && <SystemApiKeysPage />}
                    {page === 'INSTRUCTIONS' && <InstructionsPage />}
                </main>
            </div>
        </div>
    )
}
