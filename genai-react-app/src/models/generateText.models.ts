// models/textGen.models.ts
import { AIConfig } from "../context/AIContext";

export interface Prompt {
    instructionId: string
    instructionVersion: string
    prompt: string
}

export interface GenerateTextRequest {
    aiConfig: AIConfig[]
    prompt: Prompt
    selectedResponseId: string
    conversationId: string
    client: string
}

export interface GenerateTextStreamRequest {
    aiConfig: AIConfig
    prompt: Prompt
    selectedResponseId: string
    conversationId: string
    client: string
}

export interface GenerateTextResponse {
    text: string
    aiVendor: string
    messageId: string
    conversationId: string
    inputTokens?: number | null
    outputTokens?: number | null
}

export interface BatchGenerateTextRequest {
    requests: GenerateTextRequest[]
}

export interface BatchGenerateTextResponse {
    results: GenerateTextResponse[]
}
