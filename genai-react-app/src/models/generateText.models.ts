// models/textGen.models.ts
import { AIConfig } from "../context/AIContext";
import { AttachmentRef } from "./attachment.models";

export interface Prompt {
    instructionId: string
    instructionVersion: string
    prompt: string
    attachments?: AttachmentRef[]
}

export interface GenerateTextRequest {
    aiConfig: AIConfig[]
    prompt: Prompt
    selectedResponseId: string
    conversationId: string
    client: string
    /** Agent (graph) to run the generation through; omitted/null = server default. */
    agentId?: string | null
    /** Project a brand-new conversation is created into; only read when conversationId is empty. */
    projectId?: string | null
}

export interface GenerateTextStreamRequest {
    aiConfig: AIConfig
    prompt: Prompt
    selectedResponseId: string
    conversationId: string
    client: string
    /** Agent (graph) to run the generation through; omitted/null = server default. */
    agentId?: string | null
    /** Project a brand-new conversation is created into; only read when conversationId is empty. */
    projectId?: string | null
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
