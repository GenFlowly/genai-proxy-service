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
    agents: `${BASE}${API_PREFIX}/agents`,
    agent: (graphId: string) => `${BASE}${API_PREFIX}/agents/${graphId}`,
    requestAgentMap: `${BASE}${API_PREFIX}/admin/request-agent-map`,
    vendorAllowlist: `${BASE}${API_PREFIX}/admin/vendor-allowlist`,
    nodePresets: `${BASE}${API_PREFIX}/node-presets`,
    adminNodePresets: `${BASE}${API_PREFIX}/admin/node-presets`,
    adminNodePreset: (presetId: string) => `${BASE}${API_PREFIX}/admin/node-presets/${presetId}`,
    defaultGraph: `${BASE}${API_PREFIX}/admin/default-graph`,
    requestAgentMapEntry: (requestType: string) =>
        `${BASE}${API_PREFIX}/admin/request-agent-map/${requestType}`,
}
