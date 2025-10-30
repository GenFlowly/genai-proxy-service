import { config } from './env';

const BASE = config.backend.baseUrl;
const API_PREFIX = '/api/v1';

export const endpoints = {
    onboardCustomer: `${BASE}${API_PREFIX}/onboard`,
    getCustomerProfile: `${BASE}${API_PREFIX}/customer/profile`,
    storeCustomerVendorApiKey: `${BASE}${API_PREFIX}/store-api-key`,
    generateText: `${BASE}${API_PREFIX}/generate-text`,
    batchGenerateText: `${BASE}${API_PREFIX}/batch-generate-text`,
    getTextGenerationModels: `${BASE}${API_PREFIX}/models`,
};
