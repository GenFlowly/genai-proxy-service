/**
 * Conversation domain models — moved to @genflowly/component-library together
 * with the ConversationWidget. Re-exported here so the app's existing imports
 * keep working from a single source of truth.
 */
export type {
    WebSource,
    LearnedFact,
    Message,
    MessageSender,
    ConversationBlock,
    IConversationContext,
    IConversationUIContext
} from '@genflowly/component-library'
