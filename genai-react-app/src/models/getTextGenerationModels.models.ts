// models/textGenerationModels.models.ts
import { AIVendor } from '../constants/vendors'

export interface GetTextGenerationModelsRequest {
    /** Vendor ids: legacy enum names (OPENAI/CLAUDE/GEMINI) or BYOK provider ids */
    aiVendor: string[]
}

export interface GetTextGenerationModelsResponse {
    aiVendorModelList: AIVendorModelList[]
}

export interface AIVendorModelList {
    aiVendor: string
    modelsList: string[]
}