package com.genflowly.models.retrieval

import com.genflowly.models.AttachmentRef
import com.genflowly.models.DEFAULT_ATTACHMENT_MEDIA_TYPE
import com.genflowly.models.Message
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.normalizeAttachmentMediaType
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Mappers from the domain models onto the retrieval-server exchange types.
 */

private val jsonParser = Json { ignoreUnknownKeys = true }

/**
 * Attachments to send to the LLM as images: every "image/..." type, plus
 * application/octet-stream — the type uploads get when the browser declares
 * none (typical for iPhone HEIC photos). The retrieval-server identifies the
 * real format from the bytes, so the declared type is only a hint here.
 * Explicitly non-image types are skipped: generated artifacts (e.g. PDFs) also
 * live in attachments but must not be replayed to the LLM as image blocks.
 */
fun List<AttachmentRef>.toImageRefs(): List<ImageRef> =
    mapNotNull { attachment ->
        val mediaType = normalizeAttachmentMediaType(attachment.mediaType)
        if (mediaType.startsWith("image/") || mediaType == DEFAULT_ATTACHMENT_MEDIA_TYPE) {
            ImageRef(s3Key = attachment.s3Key, mediaType = mediaType)
        } else {
            null
        }
    }

/**
 * Parse the retrieval-server's generated_artifacts JSON —
 * [{"artifact_id","key","media_type","filename","size_bytes"}] — into
 * AttachmentRefs for persistence on the assistant message. The artifact id/key
 * follow the attachmentS3Key convention, so the existing attachment-download
 * endpoint serves them unchanged. Malformed input degrades to an empty list.
 */
fun parseGeneratedArtifacts(json: String?): List<AttachmentRef> {
    if (json.isNullOrBlank()) return emptyList()
    return runCatching {
        jsonParser.parseToJsonElement(json).jsonArray.mapNotNull { el ->
            val obj = el.jsonObject
            val id = obj["artifact_id"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val key = obj["key"]?.jsonPrimitive?.content ?: return@mapNotNull null
            AttachmentRef(
                attachmentId = id,
                s3Key = key,
                mediaType = obj["media_type"]?.jsonPrimitive?.content ?: "application/octet-stream",
                filename = obj["filename"]?.jsonPrimitive?.content
            )
        }
    }.getOrElse { emptyList() }
}

fun Message.toConversationMessage(): ConversationMessage =
    ConversationMessage(
        role = role,
        content = text,
        images = attachments.toImageRefs(),
        toolCalls = toolCallsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() },
        toolResults = toolResultsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() }
    )

fun List<ToolDefinition>.toPayloadTools(): List<PayloadToolDefinition> =
    map {
        PayloadToolDefinition(
            name = it.name,
            description = it.description,
            parameters = it.parameters,
            type = it.type,
            options = it.options
        )
    }

fun List<ToolResult>.toPayloadToolResults(): List<PayloadToolResult> =
    map { r ->
        PayloadToolResult(
            toolCallId = r.toolCallId,
            content = r.content,
            images = r.images.map { img ->
                PayloadToolResultImage(data = img.data, s3Key = img.s3Key, mediaType = img.mediaType)
            }
        )
    }

/**
 * Snake-cased JSON of tool results as persisted on the user Message and replayed
 * in later turns. Inline base64 screenshots are stripped (marked omitted) — raw
 * screenshots would blow DynamoDB's 400 KB item limit, and stale screenshots
 * shouldn't be replayed anyway. S3-referenced images keep their reference.
 */
fun List<ToolResult>.toResultsJson(): String? =
    takeIf { it.isNotEmpty() }?.let { results ->
        jsonParser.encodeToString(results.map { r ->
            PayloadToolResult(
                toolCallId = r.toolCallId,
                content = r.content,
                images = r.images.map { img ->
                    if (img.data != null) {
                        PayloadToolResultImage(mediaType = img.mediaType, omitted = true)
                    } else {
                        PayloadToolResultImage(s3Key = img.s3Key, mediaType = img.mediaType)
                    }
                }
            )
        })
    }
