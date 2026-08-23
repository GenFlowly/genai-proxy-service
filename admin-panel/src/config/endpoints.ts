import { config } from './env'

const BASE = config.backend.baseUrl
const API_PREFIX = '/api/v1'

export const endpoints = {
    onboardCustomer: `${BASE}${API_PREFIX}/onboard`,
    createInstruction: `${BASE}${API_PREFIX}/instruction`,
    getCustomerInstructions: `${BASE}${API_PREFIX}/instructions`,
    shareInstruction: `${BASE}${API_PREFIX}/instruction/share`,
    systemApiKeys: `${BASE}${API_PREFIX}/admin/system-api-keys`,
    systemApiKeyConfig: `${BASE}${API_PREFIX}/admin/system-api-keys/config`,
    systemApiKey: (aiVendor: string) => `${BASE}${API_PREFIX}/admin/system-api-keys/${aiVendor}`,
    systemApiKeyModels: (aiVendor: string) => `${BASE}${API_PREFIX}/admin/system-api-keys/${aiVendor}/models`,
}
