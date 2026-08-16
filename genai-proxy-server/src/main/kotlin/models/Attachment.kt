package models

import kotlinx.serialization.Serializable

/** Media types accepted for image attachments — the intersection all supported LLM vendors handle. */
val ALLOWED_ATTACHMENT_MEDIA_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

/** Anthropic's per-image limit (5 MB) — the strictest across supported vendors, applied globally. */
const val MAX_ATTACHMENT_SIZE_BYTES = 5L * 1024 * 1024

const val MAX_ATTACHMENTS_PER_MESSAGE = 10

/**
 * Reference to an image stored in the attachments S3 bucket. Only the reference
 * is persisted on messages; the bytes live in S3 under
 * customers/{customerId}/attachments/{attachmentId}.
 */
@Serializable
data class AttachmentRef(
    val attachmentId: String,
    val s3Key: String,
    val mediaType: String
)

fun attachmentS3Key(customerId: String, attachmentId: String): String =
    "customers/$customerId/attachments/$attachmentId"
