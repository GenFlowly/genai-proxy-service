import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { VectorDBConfigStatusValue } from './storeCustomerVectorDBConfig.models'
import { InstructionResponse } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        preferredGenerativeMode?: string
        /** Preferred conversation agent (graphId); absent = follow the server default */
        preferredAgentId?: string
        /** Legacy single default embedding model name; absent = platform default */
        embeddingModel?: string
        /** Default embedding model for conversation indexing; falls back to embeddingModel */
        embeddingModelConversations?: string
        /** Default embedding model for notes; falls back to embeddingModel */
        embeddingModelNotes?: string
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
    /** False only for an account that has never dismissed the first-time setup wizard */
    onboardingCompleted: boolean
}
