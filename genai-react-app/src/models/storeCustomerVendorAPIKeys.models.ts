export interface StoreCustomerVendorApiKeyRequest {
    aiVendor: string
    apiKey: string
}

export enum APIKeyStatus {
    VALID = "API key is valid",
    INVALID = "API key is not valid",
    NOT_SET = "API Key is not set"
}

export interface AIVendorAPIKeyStatus {
    aiVendor: string
    /** @deprecated Use status instead */
    isAPIKeyValid: boolean
    status: APIKeyStatus
    updateSuccessful: boolean
    /** Model internal generations (titles, personas, memory) use for this vendor */
    selectedModel?: string | null
    /** Failover priority for internal generations (1 = primary) */
    priority?: number | null
    /** Provider's own rejection message when validation fails */
    detail?: string | null
}

export interface StoreCustomerVendorApiKeyResponse {
    apiKeyStatus: AIVendorAPIKeyStatus
}

export interface StoreCustomerVendorConfigRequest {
    aiVendor: string
    model: string
    priority: number
}
