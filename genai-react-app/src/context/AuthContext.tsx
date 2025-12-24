import React, {
    createContext,
    useContext,
    useEffect,
    useState,
} from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AuthContextType, User } from '../types/auth.types'
import { onboardCustomer } from '../services/onboardUserService'
import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'

const AuthContext = createContext<AuthContextType | null>(null)

export const AuthProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => {
    const {
        user: auth0User,
        isAuthenticated,
        isLoading: auth0Loading,
        loginWithRedirect,
        logout: auth0Logout,
        getAccessTokenSilently,
    } = useAuth0()

    const [customerId, setCustomerId] = useState<string | null>(() =>
        localStorage.getItem('customerId')
    )
    const [aiVendorAPIKeyStatusList, setAiVendorAPIKeyStatusList] = useState<AIVendorAPIKeyStatus[]>([])
    const [aiConfigPreferences, setAiConfigPreferences] = useState<AuthContextType['aiConfigPreferences']>(null)
    const [isInternalLoading, setIsInternalLoading] = useState(false)

    // Persist customerId & Load cached prefs
    useEffect(() => {
        if (customerId) {
            localStorage.setItem('customerId', customerId)
            const cachedPrefs = localStorage.getItem(`${customerId}_ai_preferences`)
            if (cachedPrefs) {
                try {
                    setAiConfigPreferences(JSON.parse(cachedPrefs))
                } catch (e) {
                    console.error('Failed to parse cached ai preferences', e)
                }
            }
        } else {
            localStorage.removeItem('customerId')
            setAiConfigPreferences(null)
        }
    }, [customerId])

    // Onboard user when authenticated
    useEffect(() => {
        const onboard = async () => {
            if (isAuthenticated && auth0User && !customerId) {
                setIsInternalLoading(true)
                try {
                    const token = await getAccessTokenSilently()

                    const userInfo: User = {
                        sub: auth0User.sub || '',
                        email: auth0User.email || '',
                        name: auth0User.name || '',
                        picture: auth0User.picture,
                    }

                    const onboardData = await onboardCustomer(userInfo, token)
                    if (onboardData.customerId) {
                        setCustomerId(onboardData.customerId)
                    }
                    if (onboardData.aiVendorAPIKeyStatusList) {
                        setAiVendorAPIKeyStatusList(onboardData.aiVendorAPIKeyStatusList)
                    }
                    if (onboardData.aiConfigPreferences) {
                        setAiConfigPreferences(onboardData.aiConfigPreferences)
                        if (onboardData.customerId) {
                            localStorage.setItem(
                                `${onboardData.customerId}_ai_preferences`,
                                JSON.stringify(onboardData.aiConfigPreferences)
                            )
                        }
                    }
                } catch (error) {
                    console.error('Failed to onboard user:', error)
                } finally {
                    setIsInternalLoading(false)
                }
            }
        }

        // Ensure we don't run this excessively; depends on auth0User state
        if (isAuthenticated && auth0User) {
            onboard()
        }
    }, [isAuthenticated, auth0User, customerId, getAccessTokenSilently])

    const logout = ({ returnTo }: { returnTo: string }): void => {
        setCustomerId(null)
        setAiVendorAPIKeyStatusList([])
        setAiConfigPreferences(null)
        localStorage.removeItem('customerId')

        auth0Logout({
            logoutParams: { returnTo }
        })
    }

    // Map Auth0 User to our User type
    const user: User | null = auth0User ? {
        sub: auth0User.sub || '',
        email: auth0User.email || '',
        name: auth0User.name || '',
        picture: auth0User.picture,
    } : null

    const contextValue: AuthContextType = {
        user,
        isAuthenticated,
        isLoading: auth0Loading || isInternalLoading,
        customerId,
        setCustomerId,
        loginWithRedirect,
        logout,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        aiConfigPreferences,
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
