import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { InstructionResponseItem } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
    }
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[]
    customerInstructions?: InstructionResponseItem[]
}
