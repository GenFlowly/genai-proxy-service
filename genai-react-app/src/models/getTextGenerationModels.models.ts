// models/textGenerationModels.models.ts
import { AIVendor } from '../constants/vendors'

export interface GetTextGenerationModelsRequest {
    aiVendor: AIVendor
    customerId: string
}

export interface GetTextGenerationModelsResponse {
    aiVendor: AIVendor
    modelsList: string[]
}
