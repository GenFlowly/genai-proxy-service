/**
 * Attachment models — moved to @genflowly/component-library together with the
 * ConversationWidget. Re-exported here so the app's existing imports keep
 * working from a single source of truth.
 */
export type {
    AttachmentRef,
    CreateAttachmentUploadResponse,
    GetAttachmentUrlResponse
} from '@genflowly/component-library'
export {
    ALLOWED_ATTACHMENT_MEDIA_TYPES,
    MAX_ATTACHMENT_SIZE_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE
} from '@genflowly/component-library'
