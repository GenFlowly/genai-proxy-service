import { useCustomerAgents } from './queries/useCustomerAgents'
import { useProviderCatalog } from './queries/useProviderCatalog'
import { useRequestAgents } from './queries/useRequestAgents'

/**
 * Login-time warm-up of what the chat page and Settings → Defaults read:
 * mounting these shared queries at AppContent keeps them alive for the whole
 * session, so pages render populated on first visit. The version-gated
 * members cost zero network calls when their /onboard counter is unchanged.
 * The embedding-model catalog is deliberately excluded — Settings-only, it
 * costs per-vendor key reads + KMS decrypts server-side.
 */
export function useDefaultsPrefetch(): void {
    useProviderCatalog()
    useRequestAgents()
    useCustomerAgents()
}
