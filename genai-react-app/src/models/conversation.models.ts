import { AIVendor } from '../constants/vendors'

/**
 * Represents a single AI model's response.
 */
export interface ResponseType {
    vendor: AIVendor
    text: string
}

/**
 * Represents a single conversation block consisting of:
 * - a user’s markdown input
 * - the AI-generated responses
 * - loading state
 */
export interface ConversationBlock {
    id: string
    markdown: string
    responses: ResponseType[]
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
    addNewConversationBlock: () => void
    updateResponseInConversationBlock: (id: string, value: string) => void
    generateResponses: (id: string) => Promise<void>

    /** Per-block selected response management */
    selectedResponseByBlock: Record<string, string | null>
    setSelectedResponseForBlock: (blockId: string, responseId: string | null) => void
    getSelectedResponseForBlock: (blockId: string) => string | null
}
