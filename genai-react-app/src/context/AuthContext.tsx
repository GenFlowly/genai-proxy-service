import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AuthContextType, User } from '../types/auth.types'
import { onboardCustomer } from '../services/onboardUserService'
import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { InstructionResponse } from '../models/instruction.models'

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
    const [customerInstructions, setCustomerInstructions] = useState<InstructionResponse[]>([])
    const [isInternalLoading, setIsInternalLoading] = useState(true)

    // ✅ Effect 0: Handle Unauthenticated State to clear loading
    useEffect(() => {
        if (!auth0Loading && !isAuthenticated) {
            setIsInternalLoading(false)
        }
    }, [auth0Loading, isAuthenticated])

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
            setCustomerInstructions([])
        }
    }, [customerId])

    const logout = useCallback(({ returnTo }: { returnTo: string }): void => {
        setCustomerId(null)
        setAiVendorAPIKeyStatusList([])
        setAiConfigPreferences(null)
        setCustomerInstructions([])
        localStorage.removeItem('customerId')

        auth0Logout({
            logoutParams: { returnTo }
        })
    }, [auth0Logout])

    // Onboard/Sync user when authenticated
    useEffect(() => {
        const onboard = async () => {
            if (isAuthenticated && auth0User) {
                // Ensure we are loading (matches initial state, but safe to set)
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
                    if (onboardData.customerInstructions) {
                        setCustomerInstructions(onboardData.customerInstructions)
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
                } catch (error: any) {
                    console.error('Failed to onboard user:', error)
                    // If we fail to get a token, it likely means the session is invalid
                    // despite isAuthenticated being true (stale cache).
                    if (error?.error === 'login_required' || error?.error === 'consent_required' || error?.message?.includes('Login required')) {
                        console.log('Session invalid, logging out...')
                        logout({ returnTo: window.location.origin })
                    }
                } finally {
                    setIsInternalLoading(false)
                }
            }
        }

        // Ensure we don't run this excessively; depends on auth0User state
        if (isAuthenticated && auth0User) {
            onboard()
        }
    }, [isAuthenticated, auth0User, getAccessTokenSilently, logout])



    // Map Auth0 User to our User type
    const user: User | null = auth0User ? {
        sub: auth0User.sub || '',
        email: auth0User.email || '',
        name: auth0User.name || '',
        picture: auth0User.picture,
    } : null

    const refreshInstructions = async () => {
        if (!isAuthenticated || !auth0User) return
        try {
            const token = await getAccessTokenSilently()
            const { getCustomerInstructions } = await import('../services/instructionService')
            const response = await getCustomerInstructions(token)
            setCustomerInstructions(response.instructions)
        } catch (error) {
            console.error('Failed to refresh instructions', error)
        }
    }

    const updateInstruction = (instruction: InstructionResponse) => {
        setCustomerInstructions(prev => {
            // Check if this specific version already exists
            const index = prev.findIndex(item => item.id === instruction.id && item.version === instruction.version)

            if (index !== -1) {
                // Update existing version entry
                const newList = [...prev]
                newList[index] = instruction
                return newList
            } else {
                // Add new version (prepend)
                return [instruction, ...prev]
            }
        })
    }

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
        customerInstructions,
        refreshInstructions,
        updateInstruction,
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
