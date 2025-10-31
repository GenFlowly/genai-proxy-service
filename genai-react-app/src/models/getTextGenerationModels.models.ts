// models/textGenerationModels.models.ts
import { AIVendor } from '../constants/vendors'

export interface GetTextGenerationModelsRequest {
    vendor: AIVendor
    customerId: string
}

export interface GetTextGenerationModelsResponse {
    vendor: AIVendor
    modelsList: string[]
}
