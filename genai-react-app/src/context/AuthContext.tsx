import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from 'react'
import { AuthContextType, AuthProviderProps, User } from '../types/auth.types'
import { parseJwt } from '../utils/parseJwt'
import { HttpMethod } from '../constants/http'
import { onboardCustomer } from '../services/userSyncService'

const AuthContext = createContext<AuthContextType | null>(null)

export const AuthProvider = ({
                                 children,
                                 domain,
                                 clientId,
                                 audience,
                             }: AuthProviderProps): React.ReactElement => {
    const [user, setUser] = useState<User | null>(null)
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [accessToken, setAccessToken] = useState<string | null>(null)
    const [customerId, setCustomerId] = useState<string | null>(() =>
        localStorage.getItem('customerId')
    )

    const exchangeCodeForToken = useCallback(
        async (code: string) => {
            const response = await fetch(`https://${domain}/oauth/token`, {
                method: HttpMethod.POST,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'authorization_code',
                    client_id: clientId,
                    code,
                    redirect_uri: window.location.origin,
                }),
            })

            if (!response.ok) throw new Error('Token exchange failed')
            return response.json()
        },
        [domain, clientId]
    )

    // 👇 Persist customerId in localStorage
    useEffect(() => {
        if (customerId) {
            localStorage.setItem('customerId', customerId)
        } else {
            localStorage.removeItem('customerId')
        }
    }, [customerId])

    // 👇 Handle Auth0 redirect and onboarding
    useEffect(() => {
        const handleAuthRedirect = async () => {
            const urlParams = new URLSearchParams(window.location.search)
            const code = urlParams.get('code')

            if (!code) {
                setIsLoading(false)
                return
            }

            try {
                const tokenData = await exchangeCodeForToken(code)

                if (tokenData.id_token) {
                    const decoded = parseJwt(tokenData.id_token)
                    const userInfo: User = {
                        sub: decoded.sub,
                        email: decoded.email,
                        name: decoded.name,
                        picture: decoded.picture,
                    }

                    setUser(userInfo)
                    setIsAuthenticated(true)
                    setAccessToken(tokenData.access_token || null)

                    // ✅ Onboard user and persist customerId
                    try {
                        const onboardData = await onboardCustomer(userInfo, tokenData.access_token)
                        if (onboardData.customerId) {
                            setCustomerId(onboardData.customerId)
                        }
                    } catch (error) {
                        console.error('Failed to onboard user:', error)
                    }

                    // Clean up URL query params
                    window.history.replaceState({}, document.title, window.location.pathname)
                }
            } catch (error) {
                console.error('Auth redirect handling failed:', error)
            } finally {
                setIsLoading(false)
            }
        }

        handleAuthRedirect()
    }, [exchangeCodeForToken])

    const loginWithRedirect = (): void => {
        const redirectUri = encodeURIComponent(window.location.origin)
        window.location.href =
            `https://${domain}/authorize?` +
            `client_id=${clientId}&` +
            `response_type=code&` +
            `redirect_uri=${redirectUri}&` +
            `scope=openid%20profile%20email&` +
            `audience=${audience}`
    }

    const logout = ({ returnTo }: { returnTo: string }): void => {
        setUser(null)
        setIsAuthenticated(false)
        setAccessToken(null)
        setCustomerId(null)
        localStorage.removeItem('customerId')

        const logoutUrl =
            `https://${domain}/v2/logout?` +
            `client_id=${clientId}&` +
            `returnTo=${encodeURIComponent(returnTo)}`

        window.location.href = logoutUrl
    }

    const getAccessTokenSilently = async (): Promise<string> => {
        if (!accessToken) throw new Error('No access token available')
        return accessToken
    }

    const contextValue: AuthContextType = {
        user,
        isAuthenticated,
        isLoading,
        customerId,
        setCustomerId,
        loginWithRedirect,
        logout,
        getAccessTokenSilently,
    }

    return (
        <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
    )
}

export const useAuth = (): AuthContextType => {
    const context = useContext(AuthContext)
    if (!context) throw new Error('useAuth must be used within an AuthProvider')
    return context
}
