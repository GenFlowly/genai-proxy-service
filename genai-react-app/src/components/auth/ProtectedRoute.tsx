import React, { useEffect } from 'react'
import { useAuth0 } from '@auth0/auth0-react'

interface ProtectedRouteProps {
    children: React.ReactElement
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
    const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0()

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            loginWithRedirect({
                appState: { returnTo: window.location.pathname }
            })
        }
    }, [isLoading, isAuthenticated, loginWithRedirect])

    if (isLoading) {
        return <div data-testid="protected-route-loading">Loading...</div> // Or a nice spinner
    }

    if (!isAuthenticated) {
        return null // Will redirect via effect
    }

    return children
}
