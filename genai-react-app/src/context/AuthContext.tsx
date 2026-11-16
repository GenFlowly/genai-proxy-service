import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { AuthContextType, User } from '../types/auth.types'
import { onboardCustomer } from '../services/onboardUserService'
import { acceptAiDataConsent as acceptAiDataConsentRequest, completeOnboarding as completeOnboardingRequest } from '../services/userService'
import { CacheVersions, OnboardCustomerResponse } from '../models/onboardUser.models'
import { AIVendorAPIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'
import { InstructionResponse } from '../models/instruction.models'
import { StoreCustomerVectorDBConfigResponse } from '../models/storeCustomerVectorDBConfig.models'
import { clearHistoryCache } from '../components/widgets/ConversationHistoryWidget/historyCache'
import { memoriesCache } from '../services/memoriesService'
import { clearRecentInstructionsCache } from '../components/common/InstructionPickerModal/recentInstructionsCache'
import { customerKey } from '../utils/storageKeys'
import { queryClient } from '../queryClient'
import {
    getAiPreferences,
    mergeAiPreferences,
    replaceAiPreferences,
    setAiPreferencesCustomer,
    subscribeAiPreferences,
} from '../stores/aiPreferencesStore'
import {
    getInstructions,
    replaceInstructions,
    seedInstructions,
    setInstructionsCustomer,
    subscribeInstructions,
    upsertInstruction,
} from '../stores/instructionsStore'

const AuthContext = createContext<AuthContextType | null>(null)

// Preferences and instructions live in their own module stores so mutation
// services can write through to them. Vendor key statuses are deliberately
// NOT persisted (credential-adjacent — see utils/storageKeys.ts): they live
// in React state only and repopulate from each /onboard sync.

// Delay before a failed background onboard is re-attempted (also re-attempted
// sooner if the tab regains visibility)
const ONBOARD_RETRY_DELAY_MS = 45_000

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
    // null until the first /onboard sync resolves; false drives the first-time
    // setup wizard gate in AppContent — distinct from isOnboarding below, which
    // means "the /onboard sync call itself is in flight"
    const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
    const [aiDataConsentRequired, setAiDataConsentRequired] = useState(false)
    const [aiDataConsentAt, setAiDataConsentAt] = useState<string | null>(null)
    // Preferences and instructions live in module stores (not React state) so
    // mutation services write through to them; this context just subscribes.
    const aiConfigPreferences = useSyncExternalStore(subscribeAiPreferences, getAiPreferences)
    const customerInstructions = useSyncExternalStore(subscribeInstructions, getInstructions)
    const [customerName, setCustomerName] = useState<string | undefined>(undefined)
    const [customerPicture, setCustomerPicture] = useState<string | undefined>(undefined)
    // Version gating stays off (null) until the /onboard sync delivers real
    // counters — a cache must never be trusted on the strength of a guess.
    const [cacheVersions, setCacheVersions] = useState<CacheVersions | null>(null)
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
            setAiPreferencesCustomer(customerId)
            setInstructionsCustomer(customerId)
            // Vendor statuses were persisted here before the no-credential-caching
            // rule; logout clears all of localStorage, but an upgraded session that
            // never logs out would carry the orphan forever.
            try { localStorage.removeItem(customerKey(customerId, 'vendor_api_key_statuses')) } catch { /* ignore */ }
        } else {
            localStorage.removeItem('customerId')
            setAiPreferencesCustomer(null)
            setInstructionsCustomer(null)
        }
    }, [customerId])

    const logout = useCallback(({ returnTo, localOnly }: { returnTo: string; localOnly?: boolean }): void => {
        // Wipe ALL of localStorage so no user data survives the session on
        // this machine — a `${customerId}_` prefix sweep proved leaky
        // (unprefixed cache keys survived it). The Auth0 SDK's localstorage
        // token cache goes too; safe because auth0Logout ends the session
        // right after. The device-level theme preference is the one
        // deliberate survivor.
        const theme = localStorage.getItem('theme')
        // Module-level caches hold the departing customer's data in memory,
        // out of localStorage.clear()'s reach.
        clearHistoryCache()
        memoriesCache.clear()
        clearRecentInstructionsCache()
        try {
            localStorage.clear()
        } catch (e) {
            console.warn('Failed to clear localStorage on logout', e)
        }
        if (theme) {
            try { localStorage.setItem('theme', theme) } catch { /* best-effort */ }
        }
        // The react-query cache holds the same per-customer data in memory
        queryClient.clear()
        setCustomerId(null)
        setAiVendorAPIKeyStatusList([])
        setAiPreferencesCustomer(null)
        setInstructionsCustomer(null)
        setVectorDBConfigStatusList([])
        setCacheVersions(null)

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
                            // Identity-stable set: consumers key fetch effects on this
                            // array (AIVendorWidget re-requests /models when it changes),
                            // so an unchanged list must keep its previous identity or
                            // every onboard sync double-fires those requests.
                            const freshStatuses = onboardData.aiVendorAPIKeyStatusList
                            setAiVendorAPIKeyStatusList(prev =>
                                JSON.stringify(prev) === JSON.stringify(freshStatuses) ? prev : freshStatuses
                            )
                        }
                        if (onboardData.customerInstructions) {
                            seedInstructions(onboardData.customerId ?? null, onboardData.customerInstructions)
                        }
                        if (onboardData.customerName) setCustomerName(onboardData.customerName)
                        if (onboardData.customerPicture) setCustomerPicture(onboardData.customerPicture)

                        if (onboardData.aiConfigPreferences && onboardData.customerId) {
                            replaceAiPreferences(onboardData.customerId, onboardData.aiConfigPreferences)
                        }
                        if (onboardData.vectorDBConfigStatusList) {
                            setVectorDBConfigStatusList(onboardData.vectorDBConfigStatusList);
                        }
                        setCacheVersions(prev => {
                            const fresh = onboardData.cacheVersions ?? null
                            return JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh
                        })
                        setOnboardingCompleted(onboardData.onboardingCompleted)
                        setAiDataConsentRequired(onboardData.aiDataConsentRequired === true)
                        setAiDataConsentAt(onboardData.aiDataConsentAt ?? null)
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

    const resyncAccount = useCallback(() => {
        setOnboardAttempt(attempt => attempt + 1)
    }, [])

    const refreshInstructions = useCallback(async () => {
        try {
            let token = ""
            if (isAuthenticated && auth0User) {
                token = await getAccessTokenSilently().catch(() => "")
            }
            const { getCustomerInstructions } = await import('../services/instructionService')
            const response = await getCustomerInstructions(token)
            if (token) replaceInstructions(customerId, response.instructions)
            else seedInstructions(customerId, response.instructions)
        } catch (error) {
            console.error('Failed to refresh instructions', error)
        } finally {
            setIsInstructionsLoaded(true)
        }
    }, [isAuthenticated, auth0User, getAccessTokenSilently, customerId])

    // Thin delegation kept for existing consumers — the store is the source
    // of truth, and instructionService writes through to it on its own.
    const updateInstruction = (instruction: InstructionResponse) => {
        upsertInstruction(instruction)
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
            return updated
        })
    }

    /**
     * Thin delegation kept for existing consumers. Mutation services write
     * through to the preferences store themselves — reach for this only for
     * local-only adjustments that have no service call.
     */
    const updateAiConfigPreferences = (
        partial: Partial<NonNullable<OnboardCustomerResponse['aiConfigPreferences']>>
    ) => {
        mergeAiPreferences(partial)
    }

    // Not optimistic: callers (the onboarding wizard) keep showing the current
    // step and surface an inline error on failure, rather than this dismissing
    // the wizard before the server has actually recorded completion.
    const completeOnboarding = useCallback(async (): Promise<void> => {
        const token = await getAccessTokenSilently()
        await completeOnboardingRequest(token)
        setOnboardingCompleted(true)
    }, [getAccessTokenSilently])

    const acceptAiDataConsent = useCallback(async (): Promise<void> => {
        const token = await getAccessTokenSilently()
        setAiDataConsentAt(await acceptAiDataConsentRequest(token))
        setAiDataConsentRequired(false)
    }, [getAccessTokenSilently])

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
        // Auth0 session exists (token calls can succeed) even while /onboard is
        // still in flight and strict isAuthenticated is false. Treating that
        // window as "logged out" caused a redirect-to-login loop on deep links.
        isSessionAuthenticated: isAuthenticated,
        entitlements,
        // Only Auth0 SDK init gates rendering (fast, localStorage-backed).
        // The /onboard sync runs in the background — consumers that care use
        // isOnboarding — so a slow backend never blocks first paint.
        isLoading: auth0Loading,
        isSignedOut: !auth0Loading && !isAuthenticated,
        isOnboarding: isAuthenticated && isInternalLoading,
        isInstructionsLoaded,
        onboardingCompleted,
        completeOnboarding,
        aiDataConsentRequired,
        aiDataConsentAt,
        acceptAiDataConsent,
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
        updateAiConfigPreferences,
        customerInstructions,
        refreshInstructions,
        resyncAccount,
        updateInstruction,
        customerName,
        customerPicture,
        cacheVersions,
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
