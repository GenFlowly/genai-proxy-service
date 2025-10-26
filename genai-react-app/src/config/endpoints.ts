import { config } from './env';

const BASE = config.backend.baseUrl;
const API_PREFIX = '/api/v1';

export const endpoints = {
    onboardCustomer: `${BASE}${API_PREFIX}/onboard`,
    getCustomerProfile: `${BASE}${API_PREFIX}/customer/profile`,
    updateSettings: `${BASE}${API_PREFIX}/settings`,
    generateText: `${BASE}${API_PREFIX}/generate-text`,
};
