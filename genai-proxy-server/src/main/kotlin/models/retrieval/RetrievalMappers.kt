package com.genflowly.models.retrieval

import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Mappers from the domain models onto the retrieval-server exchange types.
 */

private val jsonParser = Json { ignoreUnknownKeys = true }

fun List<AttachmentRef>.toImageRefs(): List<ImageRef> =
    map { ImageRef(s3Key = it.s3Key, mediaType = it.mediaType) }

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
