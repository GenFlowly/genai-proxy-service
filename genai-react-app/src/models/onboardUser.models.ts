import { AIConfig } from '../context/AIContext'
import { AIVendorAPIKeyStatus } from './storeCustomerVendorAPIKeys.models'
import { VectorDBConfigStatusValue } from './storeCustomerVectorDBConfig.models'
import { InstructionResponse } from './instruction.models'

export interface OnboardCustomerResponse {
    customerId: string
    aiConfigPreferences: {
        preferredModels?: AIConfig[]
        /** Preferred conversation agent (graphId); absent = follow the server default */
        preferredAgentId?: string
        /** Legacy single default embedding model name; absent = platform default */
        embeddingModel?: string
        /** Default embedding model for conversation indexing; falls back to embeddingModel */
        embeddingModelConversations?: string
        /** Default embedding model for notes; falls back to embeddingModel */
        embeddingModelNotes?: string
        /** Memory switches (Settings > Defaults > Learned facts); absent/null = on */
        memoryLearnFromChats?: boolean | null
        memoryLearnFromNotes?: boolean | null
        memoryUseInReplies?: boolean | null
        /** Index chats for search (Settings > Defaults > Search index); absent/null = off */
        indexChats?: boolean | null
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
    /**
     * Monotonic per-resource counters bumped on every server-side mutation.
     * A cached resource whose stored counter matches the current one is
     * fresh — skip the refetch. Absent/null = no version gating this session.
     */
    cacheVersions?: CacheVersions | null
}

export interface CacheVersions {
    agents: number
    requestAgents: number
    projects: number
}
