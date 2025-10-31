import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import {
    StoreCustomerVendorApiKeyRequest
} from "../models/storeCustomerVendorAPIKeys.models";


/**
 * Stores or updates a vendor API key for a given customer.
 */
export async function storeCustomerVendorApiKey(
    token: string,
    payload: StoreCustomerVendorApiKeyRequest
): Promise<void> {
    const response = await fetch(endpoints.storeCustomerVendorApiKey, {
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
}
