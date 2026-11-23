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
    /**
     * Set by the Regenerate button: the user message id of the turn being
     * regenerated, so the backend reuses that exact message instead of
     * creating a new one.
     */
    regenerateMessageId?: string
    /**
     * Client-generated id for this generation, usable with the cancel endpoint
     * from the moment the request is sent — the server's responseMessageId
     * only arrives in the response headers, too late for a Stop pressed while
     * the model is still "thinking".
     */
    generationId?: string
    /**
     * How many vendor responses this turn has (one stream request each).
     * Memory learns once per turn, from all of them, after the last one.
     */
    turnResponseCount?: number
}

export interface GenerateTextResponse {
    text: string
    aiVendor: string
    messageId: string
    conversationId: string
    inputTokens?: number | null
    outputTokens?: number | null
}
