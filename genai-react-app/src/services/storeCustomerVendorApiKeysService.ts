import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    StoreCustomerVendorApiKeyRequest,
    StoreCustomerVendorApiKeyResponse
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
