import { AIVendor } from '../constants/vendors'

/**
 * Represents a single AI model's response.
 */
export interface Message {
    aiVendor: AIVendor
    text: string
    messageId: string
    previousMessageId?: string
    isLoading?: boolean
    thinkingSteps?: string[]
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    tokensReadFromCache?: number | null
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
    responseMessages: Message[]
    isLoading: boolean
    status: 'draft' | 'resolved'
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
    generateResponsesStream: (conversationBlockId: string, prompt?: string, selectedMessageId?: string | null, vendorToRegenerate?: AIVendor) => void
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
