package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.models.attachmentS3Key
import com.genflowly.providers.S3Provider
import org.slf4j.LoggerFactory
import java.util.UUID

/** A presigned upload of a letterhead logo. */
data class LetterheadLogoUpload(
    val attachmentId: String,
    val uploadUrl: String,
    val mediaType: String
)

/**
 * PDF letterhead logos (plan 6.2). generate_pdf reads a TOOL_EXECUTOR node's
 * `tool_settings.generate_pdf.logo_attachment_id` from the graph owner's
 * attachments, then from System's, which hold only the logos admins upload
 * here (so a customer's fork of a System agent keeps its letterhead). No
 * other customer's file is ever read.
 *
 * Admin uploads go to customers/System/attachments/{uuid} untagged: the agent's
 * node row keeps them, unlike a chat upload that expires when no message
 * links it. System is never purged.
 */
class LetterheadLogoService(private val s3Provider: S3Provider) {
    private val logger = LoggerFactory.getLogger("LetterheadLogoService")

    /**
     * Presigns an admin's logo upload under System's attachments. Throws
     * IllegalArgumentException with a client-facing message for anything but a
     * PNG or JPEG of 1 byte to 2 MB.
     */
    suspend fun createUpload(mediaType: String?, sizeBytes: Long): LetterheadLogoUpload {
        val type = mediaType?.substringBefore(';')?.trim()?.lowercase()
        require(type != null && type in MEDIA_TYPES) { "The letterhead logo must be a PNG or JPEG image." }
        require(sizeBytes in 1..MAX_BYTES) { "The letterhead logo must be at most 2 MB." }
        val attachmentId = UUID.randomUUID().toString()
        val uploadUrl = s3Provider.presignPut(attachmentS3Key(SYSTEM_GRAPH_OWNER, attachmentId), type)
        logger.info("Presigned letterhead logo upload: id={} mediaType={} sizeBytes={}", attachmentId, type, sizeBytes)
        return LetterheadLogoUpload(attachmentId, uploadUrl, type)
    }

    /** Preview URL of a System letterhead logo, or null when there is no such object. */
    suspend fun viewUrl(attachmentId: String): String? {
        if (!ID.matches(attachmentId)) return null
        val key = attachmentS3Key(SYSTEM_GRAPH_OWNER, attachmentId)
        s3Provider.head(key) ?: return null
        return s3Provider.presignGet(key)
    }

    /**
     * Whether generate_pdf can read the logo [attachmentId] for a graph owned
     * by [ownerId]: under the owner's attachments, or System's.
     */
    suspend fun exists(ownerId: String, attachmentId: String): Boolean {
        if (!ID.matches(attachmentId)) return false
        return listOf(ownerId, SYSTEM_GRAPH_OWNER).distinct().any { owner ->
            s3Provider.head(attachmentS3Key(owner, attachmentId)) != null
        }
    }

    companion object {
        val MEDIA_TYPES = setOf("image/png", "image/jpeg")
        const val MAX_BYTES = 2L * 1024 * 1024
        /** Same id shape GraphValidationService and generate_pdf accept. */
        private val ID = Regex("^[A-Za-z0-9-]{8,64}$")
    }
}
