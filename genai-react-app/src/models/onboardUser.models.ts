import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
    }
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[]
}
