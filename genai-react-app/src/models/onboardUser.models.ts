import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { VectorDBConfigStatusValue } from './storeCustomerVectorDBConfig.models'
import { InstructionResponse } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
    }
    aiVendorAPIKeyStatusList: AIVendorAPIKeyStatus[]
    customerInstructions?: InstructionResponse[]
    customerName?: string
    customerPicture?: string
    vectorDBConfigStatusList: {
        vendor: string
        isConfigValid: boolean
        status: VectorDBConfigStatusValue
        updateSuccessful: boolean
    }[]
}
