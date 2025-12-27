import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { InstructionResponse } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
    }
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[]
    customerInstructions?: InstructionResponse[]
}
