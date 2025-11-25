// models/textGen.models.ts
import {AIConfig} from "../context/AIContext";

export interface GenerateTextRequest {
    aiConfig: AIConfig[]
    prompt: string
    selectedResponseId: string
    conversationId: string
    client: string
}

export interface GenerateTextResponse {
    text: string
    aiVendor: string
    messageId: string
    conversationId: string
}

export interface BatchGenerateTextRequest {
    requests: GenerateTextRequest[]
}

export interface BatchGenerateTextResponse {
    results: GenerateTextResponse[]
}
