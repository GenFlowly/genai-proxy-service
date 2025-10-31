// models/textGen.models.ts
export interface GenerateTextRequest {
    vendor: string
    model: string
    prompt: string
    customerId: string
}

export interface GenerateTextResponse {
    text: string
    vendor: string
}

export interface BatchGenerateTextRequest {
    requests: GenerateTextRequest[]
}

export interface BatchGenerateTextResponse {
    results: GenerateTextResponse[]
}
