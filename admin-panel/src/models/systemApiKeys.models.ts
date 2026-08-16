import { AIVendor } from '../constants/vendors'

export type APIKeyStatus =
    | 'API key is valid'
    | 'API key is not valid'
    | 'API Key is not set'

export interface AIVendorAPIKeyStatus {
    aiVendor: AIVendor
    isAPIKeyValid: boolean
    status: APIKeyStatus
    updateSuccessful?: boolean
    selectedModel?: string | null
    priority?: number | null
}

export interface SystemVendorModelsResponse {
    aiVendor: AIVendor
    models: string[]
}

export interface StoreSystemVendorConfigRequest {
    aiVendor: AIVendor
    model: string
    priority: number
}

export interface StoreSystemVendorApiKeyRequest {
    aiVendor: AIVendor
    apiKey: string
}

export interface StoreSystemVendorApiKeyResponse {
    apiKeyStatus: AIVendorAPIKeyStatus
}

export interface GetSystemVendorApiKeyStatusListResponse {
    apiKeyStatuses: AIVendorAPIKeyStatus[]
}
