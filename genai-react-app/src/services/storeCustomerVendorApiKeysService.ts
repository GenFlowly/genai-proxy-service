import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    StoreCustomerVendorApiKeyRequest,
    StoreCustomerVendorApiKeyResponse,
    StoreCustomerVendorConfigRequest
} from "../models/storeCustomerVendorAPIKeys.models";


/**
 * Stores or updates a vendor API key.
 */
import { fetchWithRetry } from "../utils/apiUtils";

export async function storeCustomerVendorApiKey(
    token: string,
    payload: StoreCustomerVendorApiKeyRequest
): Promise<StoreCustomerVendorApiKeyResponse> {
    const response = await fetchWithRetry(endpoints.storeCustomerVendorApiKey, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw new Error(`Failed to save key for ${payload.aiVendor}: ${response.statusText}`)
    }

    return await response.json()
}

/**
 * Stores the model + failover priority (1 = primary) that internal
 * generations (titles, personas, memory) use for a vendor. Requires a
 * stored API key for the vendor.
 */
export async function storeCustomerVendorConfig(
    token: string,
    payload: StoreCustomerVendorConfigRequest
): Promise<void> {
    const response = await fetchWithRetry(endpoints.storeCustomerVendorConfig, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw new Error(`Failed to save config for ${payload.aiVendor}: ${response.statusText}`)
    }
}
