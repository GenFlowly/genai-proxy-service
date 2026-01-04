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
}

export interface StoreCustomerVendorApiKeyResponse {
    apiKeyStatus: AIVendorAPIKeyStatus
}
