/**
 * Attachment models — moved to @genflowly/component-library together with the
 * ConversationWidget. Re-exported here so the app's existing imports keep
 * working from a single source of truth.
 *
 * ALLOWED_ATTACHMENT_MEDIA_TYPES and MAX_ATTACHMENT_SIZE_BYTES are deliberately
 * NOT re-exported: attachments have no media-type allowlist and no size cap
 * (the proxy normalizes the declared type, the retrieval-server sniffs the
 * bytes and converts/compresses for the LLM vendors). Only the per-message
 * count limit remains.
 */
export type {
    AttachmentRef,
    CreateAttachmentUploadResponse,
    GetAttachmentUrlResponse
} from '@genflowly/component-library'
export {
    MAX_ATTACHMENTS_PER_MESSAGE
} from '@genflowly/component-library'
