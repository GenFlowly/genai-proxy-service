import { AIVendor } from '../constants/vendors'
import { AttachmentRef } from './attachment.models'

/**
 * A web-search source backing an inline [n] citation marker in the response
 * text. `index` matches the bracketed number the model emits.
 */
export interface WebSource {
    index: number
    title: string
    url: string
}

/**
 * One fact the async memory-extraction pipeline learned about the user from an
 * exchange. `memoryId` is the handle for deleting it from memory again.
 */
export interface LearnedFact {
    memoryId: string
    text: string
}

/** What a graph node does — drives the icon shown next to its thinking step. */
export type ThinkingStepKind = 'LLM' | 'MEMORY' | 'RETRIEVAL' | 'WEB_SEARCH' | 'REFLECTION'

/**
 * One structured per-node step of the agent graph's thinking phase, streamed
 * via the "ks" chunk. A node can appear multiple times (graph cycles): a later
 * `running` for the same node id after it finished starts a NEW entry, while a
 * `done` updates the latest still-running entry with that node id.
 */
export interface ThinkingStep {
    /** Node id — the correlation key between running/done events */
    node: string
    /** User-facing node name, e.g. "Query Analyzer" */
    name: string
    /**
     * Absent only on legacy fallback rows built client-side from flat "k"
     * strings — the backend always sends it.
     */
    kind?: ThinkingStepKind
    status: 'running' | 'done'
    /** Present while running, e.g. "Query Analyzer: thinking…" */
    label?: string
    /** Present when done, e.g. "Found 3 relevant document(s)" */
    detail?: string
    /** Done: retrieved doc titles / web titles / memory excerpts (≤5) */
    items?: string[]
    /** Done, LLM-backed nodes: rendered prompt sent to the model (truncated) */
    prompt?: string
    /** Done, LLM-backed nodes: the model's raw response (truncated) */
    response?: string
}

/**
 * Represents a single AI model's response.
 */
export interface Message {
    aiVendor: AIVendor
    /** Model that generated this response (e.g. "gpt-4o") */
    model?: string | null
    text: string
    messageId: string
    previousMessageId?: string
    isLoading?: boolean
    /**
     * Reason the generation failed for this vendor, if it did. Any text
     * streamed before the failure is kept in `text`; the UI renders the
     * error below it. Only ever set client-side — never persisted.
     */
    error?: string | null
    /**
     * Legacy flat thinking lines streamed via the "k" chunk. Kept for backends
     * that still emit flat strings; rendered as plain steps without an icon.
     */
    thinkingSteps?: string[]
    /**
     * Structured per-node thinking steps streamed via the "ks" chunk, in
     * arrival order (cycles append new entries for the same node id).
     */
    thinkingStepList?: ThinkingStep[]
    /**
     * Retrieval-server thinking time (request receipt → first generated token),
     * in ms. Streamed live via the "kd" chunk and persisted in DDB; null for
     * records predating the feature.
     */
    thinkingDurationMs?: number | null
    /**
     * Web-search sources for the [n] citation markers in `text`. Streamed live
     * via the "ws" chunk and persisted in DDB; absent when no web search ran.
     */
    webSources?: WebSource[] | null
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    tokensReadFromCache?: number | null
    /**
     * Exact USD cost of this response (vendor-reported token buckets priced at
     * the model-catalog rates, computed server-side and persisted per message).
     * Null for responses persisted before cost tracking.
     */
    costUsd?: number | null
    /**
     * Facts the async memory extraction learned about the user from this
     * exchange. Only set for messages loaded from history: an array (possibly
     * empty) when extraction finished, null when the backend doesn't know
     * (pending/legacy). Messages generated in this session leave it undefined —
     * the UI polls the learned-facts endpoint for those instead.
     */
    learnedFacts?: LearnedFact[] | null
}

/**
 * Represents a single conversation block consisting of:
 * - a user’s markdown input
 * - the AI-generated messages
 * - loading state
 */
export interface ConversationBlock {
    conversationBlockId: string
    prompt: string
    /** Image attachments sent with the prompt (S3 references, bytes live in the bucket) */
    attachments?: AttachmentRef[]
    responseMessages: Message[]
    isLoading: boolean
    status: 'draft' | 'resolved'
    /**
     * Epoch ms of when the prompt was sent to the generation API. Stamped
     * client-side on send; for conversations loaded from history it comes from
     * the backend's promptCreatedAt (the user message's DDB createdAt). Absent
     * only for records predating the timestamp plumbing.
     */
    sentAt?: number
}

/**
 * Shape of the Conversation Context for managing:
 * - all conversation blocks
 * - CRUD operations on blocks
 * - generation workflow
 * - selected response per block
 */
export interface IConversationContext {
    conversationBlockList: ConversationBlock[]
    conversationId: string
    activeBlockId: string
    setActiveBlockId: (id: string) => void
    activeViewportItem: { blockId: string, type: 'request' | 'response' } | null
    setActiveViewportItem: (item: { blockId: string, type: 'request' | 'response' } | null) => void
    systemPrompt: string
    setSystemPrompt: (prompt: string) => void
    addNewConversationBlock: () => void
    addNewConversationBlockWithId: (id: string) => void
    updateResponseInConversationBlock: (conversationBlockId: string, prompt: string) => void
    generateResponses: (conversationBlockId: string, prompt?: string, selectedMessageId?: string | null) => void
    generateResponsesStream: (conversationBlockId: string, prompt?: string, selectedMessageId?: string | null, vendorToRegenerate?: AIVendor, attachments?: AttachmentRef[]) => void
    stopGenerating: (blockId?: string, vendor?: string) => void

    /** Per-block selected response management */
    selectedResponseByBlock: Record<string, string | null>
    setSelectedResponseForBlock: (blockId: string, responseId: string) => void
    getSelectedResponseForBlock: (blockId: string) => string | null

    /** Per-block vendor visibility (which vendors are toggled on) */
    getVendorSelectionForBlock: (blockId: string) => string[]
    setVendorSelectionForBlock: (blockId: string, vendors: string[]) => void
    loadConversation: (id: string) => Promise<void>
    resetConversation: () => void

    /** Active Instruction Management */
    selectedInstructionId: string | null
    setSelectedInstructionId: (id: string | null) => void

    editorPrompt: string
    setEditorPrompt: (prompt: string) => void

    conversationTitle: string | null

    /** Caller's role on the loaded conversation. Defaults to OWNER for new/unloaded state. */
    conversationRole: 'OWNER' | 'EDIT' | 'VIEW'
}
