/** Reference to an image uploaded to the attachments S3 bucket. Mirrors the backend AttachmentRef. */
export interface AttachmentRef {
    attachmentId: string
    s3Key: string
    mediaType: string
}

export interface CreateAttachmentUploadResponse {
    attachmentId: string
    s3Key: string
    mediaType: string
    uploadUrl: string
}

export interface GetAttachmentUrlResponse {
    attachmentId: string
    url: string
}

/** Media types the backend accepts — the intersection all LLM vendors support. */
export const ALLOWED_ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 5 MB — matches the backend's per-image limit (Anthropic's, the strictest vendor). */
export const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024

export const MAX_ATTACHMENTS_PER_MESSAGE = 10
