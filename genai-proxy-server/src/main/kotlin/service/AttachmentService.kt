package com.genflowly.service

import com.genflowly.providers.S3Provider
import java.util.UUID
import com.genflowly.models.AttachmentUpload
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.models.PDF_MEDIA_TYPE
import com.genflowly.models.attachmentS3Key
import com.genflowly.models.formatAttachmentSize
import com.genflowly.models.normalizeAttachmentMediaType
import com.genflowly.models.sanitizeAttachmentFileName
import org.slf4j.LoggerFactory

/**
 * Attachment uploads/downloads: media-type normalization, id minting,
 * customer-scoped S3 keys and presigned URL orchestration. S3Provider stays a
 * thin presigning client underneath.
 */
class AttachmentService(
    private val s3Provider: S3Provider,
    /** Resolves downloads inside a conversation (1.11); null only in tests that never use them. */
    private val conversationService: ConversationService? = null,
    /** AppConfig.pdfUploadsEnabled: when false, PDF uploads are refused (plan 4.4 release gate). */
    private val pdfUploadsEnabled: Boolean = true
) {
    private val logger = LoggerFactory.getLogger("AttachmentService")

    /**
     * Mints an attachment id and presigns the upload. Images of any type and
     * size are accepted: the declared type is normalized (blank or malformed
     * values become application/octet-stream, never rejected) and the
     * retrieval-server later converts/compresses the image for each LLM
     * vendor. application/pdf is kept, up to [MAX_PDF_SIZE_BYTES]. The
     * returned [AttachmentUpload.mediaType] is the effective type bound into
     * the presigned PUT — the client must upload with exactly that
     * Content-Type.
     *
     * When [tagging] is set, and always for a PDF, the PUT is signed with
     * `x-amz-tagging: retention=pending` (returned in
     * [AttachmentUpload.requiredHeaders], which the client must send): the
     * object then expires unless a message links it (the 1.16 claim re-tags
     * it kept). Throws IllegalArgumentException with a client-facing message
     * for a non-positive size or an oversized PDF.
     */
    suspend fun createUploadUrl(
        customerId: String,
        mediaType: String?,
        sizeBytes: Long,
        fileName: String? = null,
        tagging: Boolean = false
    ): AttachmentUpload {
        require(sizeBytes >= 1) { "Attachment size must be at least 1 byte" }

        val effectiveMediaType = normalizeAttachmentMediaType(mediaType)
        val isPdf = effectiveMediaType == PDF_MEDIA_TYPE
        require(!isPdf || pdfUploadsEnabled) { PDF_UPLOADS_DISABLED_MESSAGE }
        require(!isPdf || sizeBytes <= MAX_PDF_SIZE_BYTES) {
            "PDF attachments are limited to ${formatAttachmentSize(MAX_PDF_SIZE_BYTES)}; " +
                "this file is ${formatAttachmentSize(sizeBytes)}"
        }
        val attachmentId = UUID.randomUUID().toString()
        val s3Key = attachmentS3Key(customerId, attachmentId)
        val signTagging = tagging || isPdf
        val uploadUrl = s3Provider.presignPut(
            s3Key, effectiveMediaType, tagging = if (signTagging) RetentionKeys.PENDING_TAGGING else null
        )

        // The declared type is raw client input of any length: log a bounded prefix only
        logger.info(
            "Presigned attachment upload for customer {}: id={} declaredMediaType={} mediaType={} sizeBytes={} tagged={}",
            customerId, attachmentId, mediaType?.take(100), effectiveMediaType, sizeBytes, signTagging
        )

        return AttachmentUpload(
            attachmentId = attachmentId,
            s3Key = s3Key,
            mediaType = effectiveMediaType,
            uploadUrl = uploadUrl,
            fileName = sanitizeAttachmentFileName(fileName),
            requiredHeaders = if (signTagging) mapOf(TAGGING_HEADER to RetentionKeys.PENDING_TAGGING) else emptyMap()
        )
    }

    /**
     * Presigned GET URL for an attachment owned by the authenticated customer,
     * or null when no such object exists. The key embeds the customerId, so a
     * customer can only ever address their own objects.
     */
    suspend fun getViewUrl(customerId: String, attachmentId: String): String? {
        val s3Key = attachmentS3Key(customerId, attachmentId)
        if (s3Provider.head(s3Key) == null) return null
        return s3Provider.presignGet(s3Key)
    }

    /**
     * Presigned GET URL for an attachment shown inside [conversationId], for
     * any participant (owner, a share recipient or a PUBLIC viewer): the key
     * is the one stored on the conversation's message, so a file generated or
     * uploaded in another participant's turn resolves too. Null when the
     * caller cannot read the conversation, the attachment is not in it, or
     * the object no longer exists.
     */
    suspend fun getViewUrlInConversation(
        customerId: String,
        attachmentId: String,
        conversationId: String
    ): String? {
        val service = checkNotNull(conversationService) { "AttachmentService has no ConversationService" }
        val s3Key = service.findAttachmentKeyInConversation(conversationId, customerId, attachmentId)
            ?: return null
        if (s3Provider.head(s3Key) == null) return null
        return s3Provider.presignGet(s3Key)
    }

    companion object {
        /** S3 header carrying an object's tags on PUT; signed into the presigned URL. */
        const val TAGGING_HEADER = "x-amz-tagging"

        const val PDF_UPLOADS_DISABLED_MESSAGE = "PDF attachments are not enabled on this server yet"
    }
}
