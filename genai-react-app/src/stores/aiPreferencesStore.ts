import { OnboardCustomerResponse } from '../models/onboardUser.models'
import { customerKey, StorageSuffix } from '../utils/storageKeys'

export type AIConfigPreferences = NonNullable<OnboardCustomerResponse['aiConfigPreferences']>

/**
 * Module-level store for the customer's AI config preferences — the single
 * local mirror of the server's CustomerPreferences row. It lives outside
 * React state so MUTATION SERVICES can write it: a service that saves
 * preferences server-side updates this store on success (write-through), and
 * every consumer (AuthContext, AIContext, widgets) sees the change without
 * waiting for the next /onboard sync. Call sites must never mirror ad hoc —
 * a forgotten mirror is how "saved but stale after reload" bugs happen.
 *
 * Persisted per customer at `${customerId}_ai_preferences` so the next
 * session paints the last known value while /onboard is in flight.
 */

let activeCustomerId: string | null = null
let prefs: AIConfigPreferences | null = null
const listeners = new Set<() => void>()

function emit(): void {
    listeners.forEach(listener => listener())
}

function persist(): void {
    if (!activeCustomerId || !prefs) return
    try {
        localStorage.setItem(
            customerKey(activeCustomerId, StorageSuffix.aiPreferences),
            JSON.stringify(prefs)
        )
    } catch {
        // Best-effort (e.g. quota) — next session just starts from /onboard
    }
}

export function subscribeAiPreferences(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getAiPreferences(): AIConfigPreferences | null {
    return prefs
}

/**
 * Switch the active customer and paint their cached copy (null = logout).
 * No-op when the customer is unchanged, so a replace that arrived before
 * React's customerId effect fires is never wiped back to the cached value.
 */
export function setAiPreferencesCustomer(customerId: string | null): void {
    if (customerId === activeCustomerId) return
    activeCustomerId = customerId
    prefs = null
    if (customerId) {
        try {
            const raw = localStorage.getItem(customerKey(customerId, StorageSuffix.aiPreferences))
            if (raw) prefs = JSON.parse(raw) as AIConfigPreferences
        } catch {
            // Corrupt cache — start empty; /onboard refills
        }
    }
    emit()
}

/**
 * Full replace from the authoritative /onboard response. Identity-stable:
 * unchanged content keeps the previous object so effects keyed on it don't
 * re-fire every sync.
 */
export function replaceAiPreferences(customerId: string, next: AIConfigPreferences): void {
    activeCustomerId = customerId
    if (prefs && JSON.stringify(prefs) === JSON.stringify(next)) {
        persist()
        return
    }
    prefs = next
    persist()
    emit()
}

/**
 * Merge a mutation's saved fields — the write-through half of "fire API +
 * update cache together". Mutation services call this on save success.
 */
export function mergeAiPreferences(partial: Partial<AIConfigPreferences>): void {
    if (Object.keys(partial).length === 0) return
    prefs = { ...(prefs ?? {}), ...partial }
    persist()
    emit()
}
