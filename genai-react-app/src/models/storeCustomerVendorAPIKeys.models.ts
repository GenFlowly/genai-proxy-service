export interface StoreCustomerVendorApiKeyRequest {
    customerId: string
    aiVendor: string
    apiKey: string
}

export interface AIVendorAPIKeyStatus {
    aiVendor: string
    isAPIKeyValid: boolean
}

export interface StoreCustomerVendorApiKeyResponse {
    apiKeyStatus: AIVendorAPIKeyStatus
}
