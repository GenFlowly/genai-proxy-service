import { HttpMethod } from '../constants/http';
import { endpoints } from '../config/endpoints';
import {
    StoreCustomerVectorDBConfigRequest,
    StoreCustomerVectorDBConfigResponse
} from "../models/storeCustomerVectorDBConfig.models";
import { fetchWithRetry } from "../utils/apiUtils";

/**
 * Stores or updates a Vector DB configuration (e.g. Zilliz).
 */
export async function storeCustomerVectorDBConfig(
    token: string,
    payload: StoreCustomerVectorDBConfigRequest
): Promise<StoreCustomerVectorDBConfigResponse> {
    const response = await fetchWithRetry(endpoints.storeCustomerVectorDBConfig, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Failed to save Vector DB config: ${response.statusText}`);
    }

    return await response.json();
}
