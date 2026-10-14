package com.genflowly.models

import kotlinx.serialization.Serializable

/*
 * Attachment uploads are deliberately permissive: any media type, no size cap.
 * Phones produce formats (HEIC/HEIF from iPhones, multi-MB photos) that the LLM
 * vendors reject, but the proxy never inspects or rewrites the bytes. The
 * retrieval-server sniffs the real format from the stored object and, per
 * vendor, passes it through untouched or converts/compresses it losslessly
 * (downscaling only to fit vendor hard limits, lossy only as a last resort)
 * before it reaches the model. The original object in S3 is never modified.
 */

/** Effective media type for blank, malformed or undeclared types (browsers often report "" for HEIC). */
const val DEFAULT_ATTACHMENT_MEDIA_TYPE = "application/octet-stream"

const val MAX_ATTACHMENTS_PER_MESSAGE = 10

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
 * image type; anything else (null, blank, garbage, over-long, non-image, or
 * scriptable like image/svg+xml) becomes [DEFAULT_ATTACHMENT_MEDIA_TYPE], so a
 * presigned GET can never serve an uploaded page or script under the bucket's
 * hostname. Never rejects — the declared type is only a hint; the
 * retrieval-server identifies the real format from the bytes.
 */
fun normalizeAttachmentMediaType(raw: String?): String {
    val candidate = canonicalMediaType(raw)
    val passiveImage = RESTRICTED_MEDIA_TYPE.matches(candidate) &&
        candidate.startsWith("image/") &&
        "svg" !in candidate && !candidate.endsWith("+xml")
    return if (passiveImage) candidate else DEFAULT_ATTACHMENT_MEDIA_TYPE
}

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
 * Reference to an image stored in the attachments S3 bucket. Only the reference
 * is persisted on messages; the bytes live in S3 under
 * customers/{customerId}/attachments/{attachmentId}.
 */
@Serializable
data class AttachmentRef(
    val attachmentId: String,
    val s3Key: String,
    val mediaType: String,
    /** Display name for downloads. Set for generated artifacts (e.g. PDFs from
     * the generate_pdf tool); null for uploaded images (pre-feature records). */
    val filename: String? = null
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
    val uploadUrl: String
)
