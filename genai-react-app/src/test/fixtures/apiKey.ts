import {
    StoreCustomerVendorApiKeyRequest,
    StoreCustomerVendorApiKeyResponse,
    APIKeyStatus
} from '../../models/storeCustomerVendorAPIKeys.models';

export const mockStoreApiKeyRequest: StoreCustomerVendorApiKeyRequest = {
    aiVendor: 'OPENAI',
    apiKey: 'sk-test-key-123'
};

export const mockStoreApiKeyResponse: StoreCustomerVendorApiKeyResponse = {
    apiKeyStatus: {
        aiVendor: 'OPENAI',
        isAPIKeyValid: true,
        status: APIKeyStatus.VALID,
        updateSuccessful: true
    }
};

export const mockStoreApiKeyFailureResponse: StoreCustomerVendorApiKeyResponse = {
    apiKeyStatus: {
        aiVendor: 'OPENAI',
        isAPIKeyValid: false,
        status: APIKeyStatus.INVALID,
        updateSuccessful: false
    }
};
