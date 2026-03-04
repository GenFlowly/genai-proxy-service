import { config } from './env';

const BASE = config.backend.baseUrl;
const API_PREFIX = '/api/v1';

export const endpoints = {
    onboardCustomer: `${BASE}${API_PREFIX}/onboard`,
    getCustomerProfile: `${BASE}${API_PREFIX}/customer/profile`,
    storeCustomerVendorApiKey: `${BASE}${API_PREFIX}/store-api-key`,
    storeCustomerVectorDBConfig: `${BASE}${API_PREFIX}/store-vector-db-config`,
    generateText: `${BASE}${API_PREFIX}/generate-text`,
    generateTextStream: `${BASE}${API_PREFIX}/generate-text-stream`,
    batchGenerateText: `${BASE}${API_PREFIX}/batch-generate-text`,
    getTextGenerationModels: `${BASE}${API_PREFIX}/models`,
    saveAIConfig: `${BASE}${API_PREFIX}/save-ai-config`,
    createInstruction: `${BASE}${API_PREFIX}/instruction`,
    getCustomerInstructions: `${BASE}${API_PREFIX}/instructions`,
};
