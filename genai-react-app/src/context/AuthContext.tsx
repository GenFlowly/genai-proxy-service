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
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { InstructionResponse } from '../models/instruction.models'
import { StoreCustomerVectorDBConfigResponse } from '../models/storeCustomerVectorDBConfig.models'

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
    const [vectorDBConfigStatusList, setVectorDBConfigStatusList] = useState<any[]>([]);
    const [supabaseConfigStatus, setSupabaseConfigStatus] = useState<any | null>(null);
    const [aiConfigPreferences, setAiConfigPreferences] = useState<OnboardCustomerResponse['aiConfigPreferences'] | null>(null);
    const [customerInstructions, setCustomerInstructions] = useState<InstructionResponse[]>([])
    const [customerName, setCustomerName] = useState<string | undefined>(undefined)
    const [customerPicture, setCustomerPicture] = useState<string | undefined>(undefined)
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
        setVectorDBConfigStatusList([]) // Clear vectorDBConfigStatusList on logout
        setSupabaseConfigStatus(null)
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
                    if (onboardData) {
                        if (onboardData.customerId) {
                            setCustomerId(onboardData.customerId)
                        }
                        if (onboardData.aiVendorAPIKeyStatusList) {
                            setAiVendorAPIKeyStatusList(onboardData.aiVendorAPIKeyStatusList)
                        }
                        if (onboardData.customerInstructions) {
                            setCustomerInstructions(onboardData.customerInstructions)
                        }
                        if (onboardData.customerName) setCustomerName(onboardData.customerName)
                        if (onboardData.customerPicture) setCustomerPicture(onboardData.customerPicture)

                        if (onboardData.aiConfigPreferences) {
                            setAiConfigPreferences(onboardData.aiConfigPreferences || null);
                            if (onboardData.customerId) {
                                localStorage.setItem(
                                    `${onboardData.customerId}_ai_preferences`,
                                    JSON.stringify(onboardData.aiConfigPreferences)
                                )
                            }
                        }
                        // Set customer instructions and vectorDBConfigStatusList if present in onboardData
                        if (onboardData.customerInstructions) {
                            setCustomerInstructions(onboardData.customerInstructions || []);
                        }
                        if (onboardData.vectorDBConfigStatusList) {
                            setVectorDBConfigStatusList(onboardData.vectorDBConfigStatusList);
                        }
                        if (onboardData.supabaseConfigStatus) {
                            setSupabaseConfigStatus(onboardData.supabaseConfigStatus);
                        }
                    }
                    console.log('User onboarded successfully');
                } catch (error: any) {
                    console.error('Failed to onboard user:', error)
                    // If we fail to get a token, it likely means the session is invalid
                    // despite isAuthenticated being true (stale cache).
                    if (error?.error === 'login_required' || error?.error === 'consent_required' || error?.message?.includes('Login required')) {
                        console.log('Session invalid, logging out...')
                        logout({ returnTo: window.location.origin })
                    } else {
                        // For other errors (e.g. 500), we must ALSO logout to ensure no sensitive Auth0 data 
                        // (like ID tokens) remains in localStorage, as per strict security requirements.
                        console.error('Onboarding failed, clearing session...', error)
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
    // Strict Display: Do not fall back to Auth0 profile for name/picture if backend failed.
    const user: User | null = auth0User ? {
        sub: auth0User.sub || '',
        email: auth0User.email || '',
        name: customerName || '', // Strictly prefer backend name; empty if missing
        picture: customerPicture, // Strictly prefer backend picture; undefined if missing
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

    const updateVendorApiKeyStatus = (status: AIVendorAPIKeyStatus) => {
        setAiVendorAPIKeyStatusList(prev => {
            const index = prev.findIndex(s => s.aiVendor === status.aiVendor)
            if (index !== -1) {
                const updated = [...prev]
                updated[index] = status
                return updated
            }
            return [...prev, status]
        })
    }

    const updateVectorDBConfigStatus = (status: StoreCustomerVectorDBConfigResponse['configStatus']) => {
        setVectorDBConfigStatusList(prev => {
            const index = prev.findIndex(s => s.vendor === status.vendor)
            if (index !== -1) {
                const updated = [...prev]
                updated[index] = status
                return updated
            }
            return [...prev, status]
        })
    }

    const updateSupabaseConfigStatus = (status: any) => {
        setSupabaseConfigStatus(status)
    }

    // Strict Authentication: Considered authenticated ONLY if Auth0 says so AND we have a customerId (onboard success).
    const isStrictlyAuthenticated = isAuthenticated && !!customerId

    const contextValue: AuthContextType = {
        user,
        isAuthenticated: isStrictlyAuthenticated,
        isLoading: auth0Loading || isInternalLoading,
        customerId,
        setCustomerId,
        loginWithRedirect,
        logout,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        vectorDBConfigStatusList, // Added vectorDBConfigStatusList to context
        supabaseConfigStatus,
        updateVendorApiKeyStatus,
        updateVectorDBConfigStatus,
        updateSupabaseConfigStatus,
        aiConfigPreferences,
        customerInstructions,
        refreshInstructions,
        updateInstruction,
        customerName,
        customerPicture,
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
