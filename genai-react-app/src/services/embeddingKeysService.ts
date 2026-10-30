import { HttpMethod } from '../constants/http'
import { endpoints } from '../config/endpoints'
import { fetchWithRetry } from '../utils/apiUtils'
import { APIKeyStatus } from '../models/storeCustomerVendorAPIKeys.models'

// Mirrors genai-proxy-server models/api/EmbeddingKeyModels.kt

/**
 * Providers a customer can bring an embedding API key for. OPENAI shares its
 * key with the text-generation vendor of the same name — one key serves both.
 * HUGGINGFACE is not an embedding provider: it is an optional Hugging Face Hub
 * token that authenticates tokenizer downloads for Voyage models. It shares
 * this credential flow but never appears in the model listings.
 */
export enum EmbeddingVendor {
    OPENAI = 'OPENAI',
    VOYAGE = 'VOYAGE',
    HUGGINGFACE = 'HUGGINGFACE',
}

export interface EmbeddingKeyStatus {
    vendor: EmbeddingVendor
    isAPIKeyValid: boolean
    status: APIKeyStatus
    updateSuccessful?: boolean
    /** Provider's own rejection message when validation fails */
    detail?: string | null
}

export interface GetEmbeddingKeysResponse {
    statuses: EmbeddingKeyStatus[]
}

export interface StoreEmbeddingKeyResponse {
    keyStatus: EmbeddingKeyStatus
}

export interface EmbeddingVendorModels {
    vendor: EmbeddingVendor
    models: string[]
}

export interface GetEmbeddingModelsResponse {
    vendorModels: EmbeddingVendorModels[]
}

/** Key status for every embedding provider. */
export async function getEmbeddingKeys(token: string): Promise<GetEmbeddingKeysResponse> {
    const response = await fetchWithRetry(endpoints.getEmbeddingKeys, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get embedding keys failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetEmbeddingKeysResponse
}

/**
 * Embedding models the customer can pick as their default, per provider.
 * Providers without a stored API key are not listed.
 */
export async function getEmbeddingModels(token: string): Promise<GetEmbeddingModelsResponse> {
    const response = await fetchWithRetry(endpoints.getEmbeddingModels, {
        method: HttpMethod.GET,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Get embedding models failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as GetEmbeddingModelsResponse
}

/** Validate and store one embedding provider's API key. */
export async function storeEmbeddingKey(
    token: string,
    vendor: EmbeddingVendor,
    apiKey: string
): Promise<StoreEmbeddingKeyResponse> {
    const response = await fetchWithRetry(endpoints.storeEmbeddingKey, {
        method: HttpMethod.POST,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ vendor, apiKey }),
    })

    if (!response.ok) {
        throw new Error(`Store embedding key failed: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as StoreEmbeddingKeyResponse
}

/**
 * Delete a stored embedding-page credential. The backend only allows
 * HUGGINGFACE — the OpenAI/Voyage keys are not deletable.
 */
export async function deleteEmbeddingKey(token: string, vendor: EmbeddingVendor): Promise<void> {
    const response = await fetchWithRetry(endpoints.deleteEmbeddingKey(vendor), {
        method: HttpMethod.DELETE,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
    })

    if (!response.ok) {
        throw new Error(`Delete embedding key failed: ${response.status} ${response.statusText}`)
    }
}
