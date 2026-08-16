import { endpoints } from '../config/endpoints'
import {
    GetSystemVendorApiKeyStatusListResponse,
    StoreSystemVendorApiKeyRequest,
    StoreSystemVendorApiKeyResponse,
    StoreSystemVendorConfigRequest,
    SystemVendorModelsResponse,
} from '../models/systemApiKeys.models'

async function assertOk(response: Response, action: string): Promise<void> {
    if (response.ok) return
    if (response.status === 403) {
        throw new Error('Admin access required — your account is not on the admin allowlist.')
    }
    throw new Error(`${action} failed: ${response.status} ${response.statusText}`)
}

export async function getSystemApiKeyStatuses(
    token: string
): Promise<GetSystemVendorApiKeyStatusListResponse> {
    const response = await fetch(endpoints.systemApiKeys, {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, 'Loading system API key statuses')
    return response.json()
}

export async function storeSystemApiKey(
    token: string,
    payload: StoreSystemVendorApiKeyRequest
): Promise<StoreSystemVendorApiKeyResponse> {
    const response = await fetch(endpoints.systemApiKeys, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Saving key for ${payload.aiVendor}`)
    return response.json()
}

export async function getSystemVendorModels(
    token: string,
    aiVendor: string
): Promise<SystemVendorModelsResponse> {
    const response = await fetch(endpoints.systemApiKeyModels(aiVendor), {
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Loading models for ${aiVendor}`)
    return response.json()
}

export async function storeSystemVendorConfig(
    token: string,
    payload: StoreSystemVendorConfigRequest
): Promise<void> {
    const response = await fetch(endpoints.systemApiKeyConfig, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })
    await assertOk(response, `Saving configuration for ${payload.aiVendor}`)
}

export async function deleteSystemApiKey(
    token: string,
    aiVendor: string
): Promise<void> {
    const response = await fetch(endpoints.systemApiKey(aiVendor), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    })
    await assertOk(response, `Deleting key for ${aiVendor}`)
}
