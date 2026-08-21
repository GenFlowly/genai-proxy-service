package com.genflowly.service

import com.genflowly.providers.S3Provider
import java.util.UUID
import com.genflowly.models.ALLOWED_ATTACHMENT_MEDIA_TYPES
import com.genflowly.models.AttachmentUpload
import com.genflowly.models.MAX_ATTACHMENT_SIZE_BYTES
import com.genflowly.models.attachmentS3Key
import org.slf4j.LoggerFactory

/**
 * Attachment uploads/downloads: media-type and size validation, id minting,
 * customer-scoped S3 keys and presigned URL orchestration. S3Provider stays a
 * thin presigning client underneath.
 */
class AttachmentService(
    private val s3Provider: S3Provider
) {
    private val logger = LoggerFactory.getLogger("AttachmentService")

    /**
     * Validates the declared media type and size, then mints an attachment id
     * and presigns the upload. Throws IllegalArgumentException with a
     * client-facing message on validation failure.
     */
    suspend fun createUploadUrl(customerId: String, mediaType: String, sizeBytes: Long): AttachmentUpload {
        require(mediaType in ALLOWED_ATTACHMENT_MEDIA_TYPES) {
            "Unsupported media type '$mediaType'. Allowed: $ALLOWED_ATTACHMENT_MEDIA_TYPES"
        }
        require(sizeBytes in 1..MAX_ATTACHMENT_SIZE_BYTES) {
            "Attachment size must be between 1 byte and $MAX_ATTACHMENT_SIZE_BYTES bytes"
        }

        val attachmentId = UUID.randomUUID().toString()
        val s3Key = attachmentS3Key(customerId, attachmentId)
        val uploadUrl = s3Provider.presignPut(s3Key, mediaType)

        logger.info(
            "Presigned attachment upload for customer {}: id={} mediaType={} sizeBytes={}",
            customerId, attachmentId, mediaType, sizeBytes
        )

        return AttachmentUpload(attachmentId = attachmentId, s3Key = s3Key, uploadUrl = uploadUrl)
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
