import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { VectorDBConfigStatusValue } from './storeCustomerVectorDBConfig.models'
import { SupabaseConfigStatus } from './storeCustomerSupabaseConfig.models'
import { InstructionResponse } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
        preferredInstructionId?: string
        instructionFallbackMode?: string
        /** Preferred conversation agent (graphId); absent = follow the server default */
        preferredAgentId?: string
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
    supabaseConfigStatus?: SupabaseConfigStatus
}
