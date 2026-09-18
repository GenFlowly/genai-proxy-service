import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AuthContextType, User } from '../types/auth.types'
import { onboardCustomer } from '../services/onboardUserService'
import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { InstructionResponse } from '../models/instruction.models'
import { StoreCustomerVectorDBConfigResponse } from '../models/storeCustomerVectorDBConfig.models'
import { clearHistoryCache } from '../components/widgets/ConversationHistoryWidget/historyCache'
import { clearNotesCache } from '../components/widgets/SidebarWidgets/SavedNotesWidget/notesCache'
import { clearRecentInstructionsCache } from '../components/common/InstructionPickerModal/recentInstructionsCache'

const AuthContext = createContext<AuthContextType | null>(null)

// Stale-while-revalidate caches: the last known server data per customer is
// shown immediately on reload, then overwritten when the background /onboard
// sync answers. Only display data belongs here — never auth state.
const vendorKeysCacheKey = (customerId: string) => `${customerId}_vendor_api_key_statuses`
const instructionsCacheKey = (customerId: string) => `${customerId}_instructions`

function readCache<T>(key: string): T | null {
    try {
        const raw = localStorage.getItem(key)
        return raw ? (JSON.parse(raw) as T) : null
    } catch {
        return null
    }
}

// Delay before a failed background onboard is re-attempted (also re-attempted
// sooner if the tab regains visibility)
const ONBOARD_RETRY_DELAY_MS = 45_000

function writeCache(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch (e) {
        // Best-effort (e.g. quota exceeded) — next load just starts empty
        console.warn(`Failed to write cache '${key}'`, e)
    }
}

export const AuthProvider = ({ children }: { children: React.ReactNode }): React.ReactElement => {
    const {
        user: auth0User,
        isAuthenticated,
        isLoading: auth0Loading,
        loginWithRedirect,
        logout: auth0Logout,
        getAccessTokenSilently: originalGetAccessTokenSilently,
    } = useAuth0()

    const [customerId, setCustomerId] = useState<string | null>(() =>
        localStorage.getItem('customerId')
    )
    const [aiVendorAPIKeyStatusList, setAiVendorAPIKeyStatusList] = useState<AIVendorAPIKeyStatus[]>([])
    const [vectorDBConfigStatusList, setVectorDBConfigStatusList] = useState<any[]>([]);
    const [aiConfigPreferences, setAiConfigPreferences] = useState<OnboardCustomerResponse['aiConfigPreferences'] | null>(null);
    const [customerInstructions, setCustomerInstructions] = useState<InstructionResponse[]>([])
    const [customerName, setCustomerName] = useState<string | undefined>(undefined)
    const [customerPicture, setCustomerPicture] = useState<string | undefined>(undefined)
    const [isInternalLoading, setIsInternalLoading] = useState(true)
    const [isInstructionsLoaded, setIsInstructionsLoaded] = useState(false)
    // Deferred re-attempt for a failed background onboard: bumping the counter
    // re-runs the onboard effect; the ref marks that a retry is warranted
    const [onboardAttempt, setOnboardAttempt] = useState(0)
    const onboardFailedRef = useRef(false)

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
            const cachedVendorStatuses = readCache<AIVendorAPIKeyStatus[]>(vendorKeysCacheKey(customerId))
            if (cachedVendorStatuses) setAiVendorAPIKeyStatusList(cachedVendorStatuses)
            const cachedInstructions = readCache<InstructionResponse[]>(instructionsCacheKey(customerId))
            if (cachedInstructions) setCustomerInstructions(cachedInstructions)
        } else {
            localStorage.removeItem('customerId')
            setAiConfigPreferences(null)
            setCustomerInstructions([])
        }
    }, [customerId])

    const logout = useCallback(({ returnTo, localOnly }: { returnTo: string; localOnly?: boolean }): void => {
        // Every per-customer localStorage entry (preferences, instructions,
        // vendor key statuses, model lists, system prompt, prompt drafts, …)
        // is keyed `${customerId}_…` — wipe them all so no user data survives
        // the session on this machine
        const departingCustomerId = localStorage.getItem('customerId')
        if (departingCustomerId) {
            try {
                Object.keys(localStorage).forEach(key => {
                    if (key.startsWith(`${departingCustomerId}_`)) {
                        localStorage.removeItem(key)
                    }
                })
            } catch (e) {
                console.warn('Failed to clear per-customer caches on logout', e)
            }
        }
        setCustomerId(null)
        setAiVendorAPIKeyStatusList([])
        setAiConfigPreferences(null)
        setCustomerInstructions([])
        setVectorDBConfigStatusList([]) // Clear vectorDBConfigStatusList on logout
        localStorage.removeItem('customerId')
        clearHistoryCache() // Cached conversation list is user data — never carry across accounts
        clearNotesCache() // Same for the cached saved-notes list
        clearRecentInstructionsCache() // Same for the cached recently-used instructions

        auth0Logout({
            logoutParams: { returnTo },
            ...(localOnly ? { openUrl: false } : {})
        })
    }, [auth0Logout])

    const getAccessTokenSilently = useCallback(async (): Promise<string> => {
        try {
            return await originalGetAccessTokenSilently()
        } catch (error: any) {
            if (
                error?.error === 'login_required' ||
                error?.error === 'consent_required' ||
                error?.message?.includes('Login required')
            ) {
                logout({ returnTo: window.location.origin, localOnly: true })
            }
            throw error
        }
    }, [originalGetAccessTokenSilently, logout])

    // Onboard/Sync user when authenticated
    useEffect(() => {
        let retryTimer: ReturnType<typeof setTimeout> | null = null

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
                            if (onboardData.customerId) {
                                writeCache(vendorKeysCacheKey(onboardData.customerId), onboardData.aiVendorAPIKeyStatusList)
                            }
                        }
                        if (onboardData.customerInstructions) {
                            setCustomerInstructions(onboardData.customerInstructions)
                            if (onboardData.customerId) {
                                writeCache(instructionsCacheKey(onboardData.customerId), onboardData.customerInstructions)
                            }
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
                        if (onboardData.vectorDBConfigStatusList) {
                            setVectorDBConfigStatusList(onboardData.vectorDBConfigStatusList);
                        }
                    }
                    onboardFailedRef.current = false
                    console.log('User onboarded successfully');
                } catch (error: any) {
                    console.error('Failed to onboard user:', error)
                    // If we fail to get a token, it likely means the session is invalid
                    // despite isAuthenticated being true (stale cache).
                    if (error?.error === 'login_required' || error?.error === 'consent_required' || error?.message?.includes('Login required')) {
                        console.log('Session invalid, logging out...')
                        logout({ returnTo: window.location.origin, localOnly: true })
                    } else {
                        // Transient failures (backend 500, network) must not destroy the
                        // Auth0 session — the user stays logged in on cached data and the
                        // sync heals itself: re-attempt after a delay (or sooner, when the
                        // tab regains visibility). Each failed attempt schedules exactly
                        // one deferred retry.
                        console.error('Onboarding failed, scheduling deferred re-attempt', error)
                        onboardFailedRef.current = true
                        retryTimer = setTimeout(() => {
                            setOnboardAttempt(attempt => attempt + 1)
                        }, ONBOARD_RETRY_DELAY_MS)
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

        return () => {
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [isAuthenticated, auth0User, getAccessTokenSilently, logout, onboardAttempt])

    // Proactive session check: when the user returns to the tab after being idle,
    // verify the refresh token is still valid. If not, logout immediately so the
    // UI shows the Login button instead of appearing to be logged in.
    useEffect(() => {
        if (!isAuthenticated) return

        const checkSession = async () => {
            if (document.visibilityState !== 'visible') return
            // A failed background onboard gets re-attempted as soon as the
            // user comes back to the tab, without waiting out the retry timer
            if (onboardFailedRef.current) {
                onboardFailedRef.current = false
                setOnboardAttempt(attempt => attempt + 1)
            }
            try {
                await getAccessTokenSilently()
            } catch (error: any) {
                if (
                    error?.error === 'login_required' ||
                    error?.error === 'consent_required' ||
                    error?.message?.includes('Login required')
                ) {
                    logout({ returnTo: window.location.origin, localOnly: true })
                }
            }
        }

        document.addEventListener('visibilitychange', checkSession)
        return () => document.removeEventListener('visibilitychange', checkSession)
    }, [isAuthenticated, getAccessTokenSilently, logout])



    // Map Auth0 User to our User type
    // Strict Display: Do not fall back to Auth0 profile for name/picture if backend failed.
    const user: User | null = auth0User ? {
        sub: auth0User.sub || '',
        email: auth0User.email || '',
        name: customerName || '', // Strictly prefer backend name; empty if missing
        picture: customerPicture, // Strictly prefer backend picture; undefined if missing
    } : null

    const refreshInstructions = useCallback(async () => {
        try {
            let token = ""
            if (isAuthenticated && auth0User) {
                token = await getAccessTokenSilently().catch(() => "")
            }
            const { getCustomerInstructions } = await import('../services/instructionService')
            const response = await getCustomerInstructions(token)
            setCustomerInstructions(response.instructions)
            if (customerId) writeCache(instructionsCacheKey(customerId), response.instructions)
        } catch (error) {
            console.error('Failed to refresh instructions', error)
        } finally {
            setIsInstructionsLoaded(true)
        }
    }, [isAuthenticated, auth0User, getAccessTokenSilently, customerId])

    const updateInstruction = (instruction: InstructionResponse) => {
        setCustomerInstructions(prev => {
            // Check if this specific version already exists
            const index = prev.findIndex(item => item.id === instruction.id && item.version === instruction.version)

            let newList: InstructionResponse[]
            if (index !== -1) {
                // Update existing version entry
                newList = [...prev]
                newList[index] = instruction
            } else {
                // Add new version (prepend)
                newList = [instruction, ...prev]
            }
            if (customerId) writeCache(instructionsCacheKey(customerId), newList)
            return newList
        })
    }

    const updateVendorApiKeyStatus = (status: AIVendorAPIKeyStatus) => {
        setAiVendorAPIKeyStatusList(prev => {
            const index = prev.findIndex(s => s.aiVendor === status.aiVendor)
            let updated: AIVendorAPIKeyStatus[]
            if (index !== -1) {
                updated = [...prev]
                updated[index] = status
            } else {
                updated = [...prev, status]
            }
            if (customerId) writeCache(vendorKeysCacheKey(customerId), updated)
            return updated
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

    // Strict Authentication: Considered authenticated ONLY if Auth0 says so AND we have a customerId (onboard success).
    const isStrictlyAuthenticated = isAuthenticated && !!customerId

    // Central entitlements: single source of truth for what the customer may do.
    // Sharing requires a logged-in (onboarded) customer.
    const entitlements = {
        canShare: isStrictlyAuthenticated,
    }

    const contextValue: AuthContextType = {
        user,
        isAuthenticated: isStrictlyAuthenticated,
        entitlements,
        // Only Auth0 SDK init gates rendering (fast, localStorage-backed).
        // The /onboard sync runs in the background — consumers that care use
        // isOnboarding — so a slow backend never blocks first paint.
        isLoading: auth0Loading,
        isOnboarding: isAuthenticated && isInternalLoading,
        isInstructionsLoaded,
        customerId,
        setCustomerId,
        loginWithRedirect,
        logout,
        getAccessTokenSilently,
        aiVendorAPIKeyStatusList,
        vectorDBConfigStatusList, // Added vectorDBConfigStatusList to context
        updateVendorApiKeyStatus,
        updateVectorDBConfigStatus,
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
