package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_PDFS_PER_MESSAGE
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.formatAttachmentSize
import com.genflowly.models.isImageAttachmentMediaType
import com.genflowly.models.isPdfAttachmentMediaType
import com.genflowly.providers.S3Provider

/**
 * Validates the caller-supplied parts of a generation request — attachments
 * and tool definitions/results — before any orchestration work starts.
 * Failures throw IllegalArgumentException with a client-facing message.
 */
class GenerationRequestValidator(
    private val s3Provider: S3Provider,
    /** AppConfig.pdfUploadsEnabled: when false, a message with a PDF is refused (plan 4.4). */
    private val pdfUploadsEnabled: Boolean = true
) {

    /**
     * Rejects more than [MAX_ATTACHMENTS_PER_MESSAGE] attachments or
     * [MAX_PDFS_PER_MESSAGE] PDFs, attachments the caller doesn't own (key
     * must sit under the authenticated customer's prefix), ones declared as
     * neither an image nor a PDF (they would otherwise be silently left out of
     * the model's input) and ones that were never actually uploaded. Each PDF
     * is checked against the stored object: at most [MAX_PDF_SIZE_BYTES] and
     * stored as application/pdf. Images have no size or image-type check: the
     * retrieval-server converts/compresses each image to fit the target
     * vendor. Runs only for the current turn's attachments — history
     * attachments were validated when their message was created.
     */
    suspend fun validateAttachments(attachments: List<AttachmentRef>, customerId: String) {
        if (attachments.isEmpty()) return
        require(attachments.size <= MAX_ATTACHMENTS_PER_MESSAGE) {
            "At most $MAX_ATTACHMENTS_PER_MESSAGE attachments are allowed per message"
        }
        val pdfCount = attachments.count { isPdfAttachmentMediaType(it.mediaType) }
        require(pdfCount == 0 || pdfUploadsEnabled) { AttachmentService.PDF_UPLOADS_DISABLED_MESSAGE }
        require(pdfCount <= MAX_PDFS_PER_MESSAGE) {
            "At most $MAX_PDFS_PER_MESSAGE PDFs are allowed per message (this message has $pdfCount)"
        }
        val ownedPrefix = "customers/$customerId/"
        for (attachment in attachments) {
            require(attachment.s3Key.startsWith(ownedPrefix)) {
                "Attachment ${attachment.attachmentId} does not belong to the authenticated customer"
            }
            val isPdf = isPdfAttachmentMediaType(attachment.mediaType)
            require(isPdf || isImageAttachmentMediaType(attachment.mediaType)) {
                "Attachment ${attachment.attachmentId} is not an image or a PDF (mediaType " +
                    "'${attachment.mediaType.take(100)}'); only images and PDFs can be attached"
            }
            val stored = s3Provider.head(attachment.s3Key)
                ?: throw IllegalArgumentException("Attachment ${attachment.attachmentId} has not been uploaded")
            if (isPdf) {
                // Ids only: the route logs this message, and a file name is user content
                require(stored.sizeBytes <= MAX_PDF_SIZE_BYTES) {
                    "PDF attachment ${attachment.attachmentId} is ${formatAttachmentSize(stored.sizeBytes)}; " +
                        "PDFs are limited to ${formatAttachmentSize(MAX_PDF_SIZE_BYTES)}"
                }
                require(isPdfAttachmentMediaType(stored.contentType)) {
                    "Attachment ${attachment.attachmentId} was not uploaded as a PDF"
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
