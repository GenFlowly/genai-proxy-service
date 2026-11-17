import { useAuth } from '../context/AuthContext'
import { APIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'

/**
 * Whether the customer brings their own AI keys (BYOK) — any stored LLM key,
 * valid or not. Outside BYOK Settings, copy that only makes sense for
 * own-key customers (estimates, key deletion, setup rows) depends on this.
 */
export function useHasOwnKeys(): boolean {
    const { aiVendorAPIKeyStatusList } = useAuth()
    return aiVendorAPIKeyStatusList.some(status => status.isAPIKeyValid || status.status !== APIKeyStatus.NOT_SET)
}
