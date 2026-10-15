package com.genflowly.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/*
 * Image uploads are deliberately permissive: any image type, no size cap.
 * Phones produce formats (HEIC/HEIF from iPhones, multi-MB photos) that the LLM
 * vendors reject, but the proxy never inspects or rewrites the bytes. The
 * retrieval-server sniffs the real format from the stored object and, per
 * vendor, passes it through untouched or converts/compresses it losslessly
 * (downscaling only to fit vendor hard limits, lossy only as a last resort)
 * before it reaches the model. The original object in S3 is never modified.
 *
 * PDFs (application/pdf) are the one non-image type kept: at most
 * [MAX_PDF_SIZE_BYTES] each (checked at presign and again against the stored
 * object) and [MAX_PDFS_PER_MESSAGE] per message.
 */

/** Effective media type for blank, malformed or undeclared types (browsers often report "" for HEIC). */
const val DEFAULT_ATTACHMENT_MEDIA_TYPE = "application/octet-stream"

const val PDF_MEDIA_TYPE = "application/pdf"

const val MAX_ATTACHMENTS_PER_MESSAGE = 10

/** 10 MiB per input PDF - the same limit the UI enforces client-side. */
const val MAX_PDF_SIZE_BYTES = 10L * 1024 * 1024

const val MAX_PDFS_PER_MESSAGE = 5

/** Longest upload file name kept for display; longer names are truncated. */
const val MAX_ATTACHMENT_FILE_NAME_LENGTH = 255

/**
 * RFC 6838 media type: `type/subtype`, each a restricted-name (first char
 * alphanumeric, then up to 126 of ALPHA / DIGIT / ! # $ & - ^ _ . +). This also
 * caps the whole value at 255 chars and rules out whitespace and CR/LF, so the
 * result is safe to bind into the presigned PUT's Content-Type.
 */
private val RESTRICTED_MEDIA_TYPE =
    Regex("^[a-z0-9][a-z0-9!#\$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#\$&^_.+-]{0,126}$")

/** Trims, drops any `;parameters` and lowercases a declared media type. */
private fun canonicalMediaType(raw: String?): String =
    raw.orEmpty().substringBefore(';').trim().lowercase()

/**
 * Normalizes a client-declared attachment media type into the effective one
 * stored with the object (it is bound into the presigned PUT, and S3 serves
 * the object with it). Kept only when it is a syntactically valid, passive
 * image type or application/pdf; anything else (null, blank, garbage,
 * over-long, other non-image types, or scriptable like image/svg+xml) becomes
 * [DEFAULT_ATTACHMENT_MEDIA_TYPE], so a presigned GET can never serve an
 * uploaded page or script under the bucket's hostname. Never rejects — the
 * declared type is only a hint; the retrieval-server identifies the real
 * format from the bytes.
 */
fun normalizeAttachmentMediaType(raw: String?): String {
    val candidate = canonicalMediaType(raw)
    if (candidate == PDF_MEDIA_TYPE) return PDF_MEDIA_TYPE
    val passiveImage = RESTRICTED_MEDIA_TYPE.matches(candidate) &&
        candidate.startsWith("image/") &&
        "svg" !in candidate && !candidate.endsWith("+xml")
    return if (passiveImage) candidate else DEFAULT_ATTACHMENT_MEDIA_TYPE
}

/** Whether [mediaType] (parameters and case ignored) is application/pdf. */
fun isPdfAttachmentMediaType(mediaType: String?): Boolean = canonicalMediaType(mediaType) == PDF_MEDIA_TYPE

/**
 * The upload's file name as kept for display (persisted as
 * AttachmentRef.filename by the client's generate request): trimmed, control
 * characters removed, at most [MAX_ATTACHMENT_FILE_NAME_LENGTH] characters.
 * Null when nothing is left.
 */
fun sanitizeAttachmentFileName(raw: String?): String? =
    raw?.filterNot { it.isISOControl() }
        ?.trim()
        ?.take(MAX_ATTACHMENT_FILE_NAME_LENGTH)
        ?.takeIf { it.isNotBlank() }

/** "10.0 MB" style size for client-facing messages (MiB, one decimal). */
fun formatAttachmentSize(bytes: Long): String = "%.1f MB".format(java.util.Locale.ROOT, bytes / (1024.0 * 1024.0))

/**
 * Whether an attachment declared with [mediaType] is meant as an image for the
 * model: any image type, or untyped (blank / application/octet-stream — what
 * uploads get when the browser declares none, typical for iPhone HEIC photos).
 * False for explicitly non-image types such as generated PDF artifacts.
 */
fun isImageAttachmentMediaType(mediaType: String?): Boolean {
    val candidate = canonicalMediaType(mediaType)
    return candidate.isEmpty() || candidate.startsWith("image/") || candidate == DEFAULT_ATTACHMENT_MEDIA_TYPE
}

/**
 * Reference to a file stored in the attachments S3 bucket: an uploaded image or
 * a file a built-in tool generated (e.g. a PDF). Only the reference is persisted
 * on messages; the bytes live in S3 under
 * customers/{customerId}/attachments/{attachmentId}.
 */
@Serializable
data class AttachmentRef(
    val attachmentId: String,
    val s3Key: String,
    val mediaType: String,
    /** Display name for downloads. Set for generated artifacts (e.g. PDFs from
     * the generate_pdf tool); null for uploaded images (pre-feature records). */
    val filename: String? = null,
    /** Object size in bytes, shown on the attachment card. Generated artifacts
     * carry the retrieval-server's size_bytes. Null for records predating it. */
    val sizeBytes: Long? = null,
    /**
     * S3 key of a generated artifact's stored Markdown source
     * (`<s3Key>.source.md`), so purge and the kept-object claim can find it.
     * Server-side only: @Transient keeps it out of every JSON body, so it is
     * never sent to the browser and never accepted from a client. It is
     * persisted and read through ConversationRepository's DynamoDB mapping.
     * Null for uploads and for records predating it (those fall back to
     * `s3Key + ".source.md"` where a source may exist).
     */
    @Transient
    val sourceKey: String? = null,
    /** Page count of a PDF when known; null otherwise. */
    val pageCount: Int? = null
)

fun attachmentS3Key(customerId: String, attachmentId: String): String =
    "customers/$customerId/attachments/$attachmentId"

/**
 * Metadata of an uploaded attachment object, as reported by S3.
 */
data class AttachmentObjectInfo(
    val sizeBytes: Long,
    val contentType: String?
)

/** Result of preparing an attachment upload: identifiers plus the presigned PUT URL. */
data class AttachmentUpload(
    val attachmentId: String,
    val s3Key: String,
    /** Effective (normalized) media type bound into the presigned PUT; the client must upload with it. */
    val mediaType: String,
    val uploadUrl: String,
    /** The sanitized upload file name, for the client to send back as AttachmentRef.filename. */
    val fileName: String? = null,
    /** Headers signed into the presigned PUT (e.g. x-amz-tagging); the client must send each one. */
    val requiredHeaders: Map<String, String> = emptyMap()
)
