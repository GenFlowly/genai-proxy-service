package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.AttachmentKind
import com.genflowly.models.ACCEPTED_ATTACHMENT_KINDS
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_PDFS_PER_MESSAGE
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.models.PDF_MEDIA_TYPE
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.attachmentKind
import com.genflowly.providers.S3Provider

/**
 * Validates the caller-supplied parts of a generation request — attachments
 * and tool definitions/results — before any orchestration work starts.
 * Failures throw IllegalArgumentException with a client-facing message.
 */
class GenerationRequestValidator(
    private val s3Provider: S3Provider
) {

    /**
     * Rejects more than [MAX_ATTACHMENTS_PER_MESSAGE] attachments (and more than
     * [MAX_PDFS_PER_MESSAGE] PDFs), attachments the caller doesn't own (key must
     * sit under the authenticated customer's prefix), ones of an unaccepted kind
     * (see [ACCEPTED_ATTACHMENT_KINDS] — they would otherwise be silently left
     * out of the model's input), and ones that were never actually uploaded.
     * Images carry no size check (the retrieval-server downscales them per
     * vendor); a PDF is HEADed and refused unless it is really `application/pdf`
     * and within [MAX_PDF_SIZE_BYTES] — this is the authoritative size gate,
     * since the presigned PUT can't bound the upload at S3. Runs only for the
     * current turn's attachments — history attachments were validated when their
     * message was created. Throws IllegalArgumentException with a client-facing
     * message (the generation route maps it to a 400).
     */
    suspend fun validateAttachments(attachments: List<AttachmentRef>, customerId: String) {
        if (attachments.isEmpty()) return
        require(attachments.size <= MAX_ATTACHMENTS_PER_MESSAGE) {
            "At most $MAX_ATTACHMENTS_PER_MESSAGE attachments are allowed per message"
        }
        val pdfCount = attachments.count { attachmentKind(it.mediaType) == AttachmentKind.PDF }
        require(pdfCount <= MAX_PDFS_PER_MESSAGE) {
            "At most $MAX_PDFS_PER_MESSAGE PDFs are allowed per message"
        }
        val ownedPrefix = "customers/$customerId/"
        for (attachment in attachments) {
            require(attachment.s3Key.startsWith(ownedPrefix)) {
                "Attachment ${attachment.attachmentId} does not belong to the authenticated customer"
            }
            val kind = attachmentKind(attachment.mediaType)
            require(kind in ACCEPTED_ATTACHMENT_KINDS) {
                "Attachment ${attachment.attachmentId} has an unsupported type (mediaType " +
                    "'${attachment.mediaType.take(100)}'); only images and PDFs can be attached"
            }
            val info = s3Provider.head(attachment.s3Key)
                ?: throw IllegalArgumentException("Attachment ${attachment.attachmentId} has not been uploaded")
            if (kind == AttachmentKind.PDF) {
                require(info.contentType == PDF_MEDIA_TYPE) {
                    "Attachment ${attachment.attachmentId} is not stored as a PDF " +
                        "(content type '${info.contentType?.take(100)}')"
                }
                require(info.sizeBytes <= MAX_PDF_SIZE_BYTES) {
                    "PDF ${attachment.attachmentId} exceeds the " +
                        "${MAX_PDF_SIZE_BYTES / (1024 * 1024)} MB limit"
                }
            }
        }
    }

    /**
     * Native tool types (computer use etc.) are Anthropic-only; tool-result image
     * S3 keys must belong to the authenticated customer.
     */
    fun validateTools(
        tools: List<ToolDefinition>,
        toolResults: List<ToolResult>,
        vendors: List<AIVendor>,
        customerId: String
    ) {
        val nativeTypes = tools.mapNotNull { it.type }.filter { it != "function" }
        if (nativeTypes.isNotEmpty()) {
            require(vendors.all { it == AIVendor.CLAUDE }) {
                "Native tool types $nativeTypes are supported on Claude only — use function tools for other vendors"
            }
        }
        val ownedPrefix = "customers/$customerId/"
        for (result in toolResults) {
            for (img in result.images) {
                require(img.data != null || img.s3Key != null) {
                    "Tool result image must provide either data or s3Key"
                }
                img.s3Key?.let {
                    require(it.startsWith(ownedPrefix)) {
                        "Tool result image s3Key does not belong to the authenticated customer"
                    }
                }
            }
        }
    }
}
