import { AIVendor } from '../constants/vendors'

/**
 * Represents a single AI model's response.
 */
export interface Message {
    aiVendor: AIVendor
    text: string
    messageId: string
    previousMessageId?: string
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
}

/**
 * Shape of the Conversation Context for managing:
 * - all conversation blocks
 * - CRUD operations on blocks
 * - generation workflow
 * - selected response per block
 */
export interface ConversationContextType {
    conversationBlockList: ConversationBlock[]
    conversationId: string
    addNewConversationBlock: () => void
    addNewConversationBlockWithId: (id: string) => void
    updateResponseInConversationBlock: (id: string, value: string) => void
    generateResponses: (id: string) => Promise<void>

    /** Per-block selected response management */
    selectedResponseByBlock: Record<string, string | null>
    setSelectedResponseForBlock: (blockId: string, responseId: string) => void
    getSelectedResponseForBlock: (blockId: string) => string | null
}
