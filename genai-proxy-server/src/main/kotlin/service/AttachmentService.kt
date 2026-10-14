package com.genflowly.service

import com.genflowly.providers.S3Provider
import java.util.UUID
import com.genflowly.models.AttachmentUpload
import com.genflowly.models.attachmentS3Key
import com.genflowly.models.normalizeAttachmentMediaType
import org.slf4j.LoggerFactory

/**
 * Attachment uploads/downloads: media-type normalization, id minting,
 * customer-scoped S3 keys and presigned URL orchestration. S3Provider stays a
 * thin presigning client underneath.
 */
class AttachmentService(
    private val s3Provider: S3Provider
) {
    private val logger = LoggerFactory.getLogger("AttachmentService")

    /**
     * Mints an attachment id and presigns the upload. Any media type and size
     * are accepted: the declared type is normalized (blank or malformed values
     * become application/octet-stream, never rejected) and the retrieval-server
     * later converts/compresses the image for each LLM vendor. The returned
     * [AttachmentUpload.mediaType] is the effective type bound into the
     * presigned PUT — the client must upload with exactly that Content-Type.
     * Throws IllegalArgumentException with a client-facing message only for a
     * non-positive size.
     */
    suspend fun createUploadUrl(customerId: String, mediaType: String?, sizeBytes: Long): AttachmentUpload {
        require(sizeBytes >= 1) { "Attachment size must be at least 1 byte" }

        val effectiveMediaType = normalizeAttachmentMediaType(mediaType)
        val attachmentId = UUID.randomUUID().toString()
        val s3Key = attachmentS3Key(customerId, attachmentId)
        val uploadUrl = s3Provider.presignPut(s3Key, effectiveMediaType)

        // The declared type is raw client input of any length: log a bounded prefix only
        logger.info(
            "Presigned attachment upload for customer {}: id={} declaredMediaType={} mediaType={} sizeBytes={}",
            customerId, attachmentId, mediaType?.take(100), effectiveMediaType, sizeBytes
        )

        return AttachmentUpload(
            attachmentId = attachmentId,
            s3Key = s3Key,
            mediaType = effectiveMediaType,
            uploadUrl = uploadUrl
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
}
