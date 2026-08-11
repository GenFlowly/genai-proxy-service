import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import {
    CreateDeveloperApiKeyRequest,
    DeveloperApiKeyCreatedResponse,
    ListDeveloperApiKeysResponse,
} from '../models/developerApiKeys.models'

/**
 * Creates a developer API key. The full key is only present in this response —
 * it can never be retrieved again afterwards.
 */
export async function createDeveloperApiKey(
    token: string,
    payload: CreateDeveloperApiKeyRequest
): Promise<DeveloperApiKeyCreatedResponse> {
    const response = await fetchWithRetry(endpoints.developerApiKeys, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    })

    if (!response.ok) {
        throw new Error(`Failed to create API key: ${response.statusText}`)
    }

    return await response.json()
}

export async function listDeveloperApiKeys(
    token: string
): Promise<ListDeveloperApiKeysResponse> {
    const response = await fetchWithRetry(endpoints.developerApiKeys, {
        method: HttpMethod.GET,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to load API keys: ${response.statusText}`)
    }

    return await response.json()
}

export async function revokeDeveloperApiKey(
    token: string,
    keyId: string
): Promise<void> {
    const response = await fetchWithRetry(endpoints.developerApiKey(keyId), {
        method: HttpMethod.DELETE,
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Failed to revoke API key: ${response.statusText}`)
    }
}
