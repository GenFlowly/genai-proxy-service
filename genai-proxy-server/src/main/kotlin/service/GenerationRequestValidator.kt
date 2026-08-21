package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_ATTACHMENT_SIZE_BYTES
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
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
     * Rejects attachments the caller doesn't own (key must sit under the
     * authenticated customer's prefix) or that were never actually uploaded /
     * exceed the size limit. Runs only for the current turn's attachments —
     * history attachments were validated when their message was created.
     */
    suspend fun validateAttachments(attachments: List<AttachmentRef>, customerId: String) {
        if (attachments.isEmpty()) return
        require(attachments.size <= MAX_ATTACHMENTS_PER_MESSAGE) {
            "At most $MAX_ATTACHMENTS_PER_MESSAGE attachments are allowed per message"
        }
        val ownedPrefix = "customers/$customerId/"
        for (attachment in attachments) {
            require(attachment.s3Key.startsWith(ownedPrefix)) {
                "Attachment ${attachment.attachmentId} does not belong to the authenticated customer"
            }
            val info = s3Provider.head(attachment.s3Key)
                ?: throw IllegalArgumentException("Attachment ${attachment.attachmentId} has not been uploaded")
            require(info.sizeBytes <= MAX_ATTACHMENT_SIZE_BYTES) {
                "Attachment ${attachment.attachmentId} exceeds the $MAX_ATTACHMENT_SIZE_BYTES byte limit"
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
