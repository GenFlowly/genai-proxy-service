package com.genflowly.models.retrieval

import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.isImageAttachmentMediaType
import com.genflowly.models.normalizeAttachmentMediaType
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * Mappers from the domain models onto the retrieval-server exchange types.
 */

private val jsonParser = Json { ignoreUnknownKeys = true }

/**
 * Attachments to send to the LLM as images: every image type plus untyped
 * uploads (see [isImageAttachmentMediaType]). The retrieval-server identifies
 * the real format from the bytes, so the declared type is only a hint here.
 * Explicitly non-image types are skipped: generated artifacts (e.g. PDFs) also
 * live in attachments but must not be replayed to the LLM as image blocks.
 */
fun List<AttachmentRef>.toImageRefs(): List<ImageRef> =
    filter { isImageAttachmentMediaType(it.mediaType) }
        .map { ImageRef(s3Key = it.s3Key, mediaType = normalizeAttachmentMediaType(it.mediaType)) }

/**
 * The complement of [toImageRefs]: every non-image attachment as a [FileRef]
 * (contract C10) with the given [origin] — generated files on assistant turns,
 * uploaded documents on user turns. The stored s3Key is passed exactly as
 * persisted: in a shared conversation it can sit under another participant's
 * prefix.
 */
fun List<AttachmentRef>.toFileRefs(origin: FileOrigin): List<FileRef> =
    filterNot { isImageAttachmentMediaType(it.mediaType) }
        .map {
            FileRef(
                attachmentId = it.attachmentId,
                s3Key = it.s3Key,
                mediaType = it.mediaType,
                filename = it.filename,
                sizeBytes = it.sizeBytes,
                origin = origin
            )
        }

/** A plausible BCP-47 tag: a primary subtag of 2-8 letters, then subtags of 1-8 letters or digits. */
private val LANGUAGE_TAG = Regex("^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$")
private const val MAX_LOCALE_LENGTH = 35

/**
 * The browser's locale for RawData.locale (contract C11): the first language
 * tag of an Accept-Language header, e.g. "en-US" from "en-US,en;q=0.9,de;q=0.8".
 * q-values are ignored (browsers already list tags by preference), and so are
 * "*" and any entry that is not a plausible BCP-47 tag of at most 35
 * characters. Null when the header is absent or names no usable tag.
 */
fun localeFromAcceptLanguage(header: String?): String? =
    header?.splitToSequence(',')
        ?.map { it.substringBefore(';').trim() }
        ?.firstOrNull { it.length <= MAX_LOCALE_LENGTH && LANGUAGE_TAG.matches(it) }

/**
 * Parse the retrieval-server's generated_artifacts JSON —
 * [{"artifact_id","key","media_type","filename","size_bytes","source_key",
 * "page_count"}] — into AttachmentRefs for persistence on the assistant
 * message. The artifact id/key follow the attachmentS3Key convention, so the
 * existing attachment-download endpoint serves them unchanged. Optional fields
 * that are missing, null or of the wrong type stay null. Malformed input
 * degrades to an empty list.
 */
fun parseGeneratedArtifacts(json: String?): List<AttachmentRef> {
    if (json.isNullOrBlank()) return emptyList()
    return runCatching {
        jsonParser.parseToJsonElement(json).jsonArray.mapNotNull { el ->
            val obj = el.jsonObject
            val id = obj.primitiveOrNull("artifact_id")?.content ?: return@mapNotNull null
            val key = obj.primitiveOrNull("key")?.content ?: return@mapNotNull null
            AttachmentRef(
                attachmentId = id,
                s3Key = key,
                mediaType = obj.primitiveOrNull("media_type")?.content ?: "application/octet-stream",
                filename = obj.primitiveOrNull("filename")?.content,
                sizeBytes = obj.primitiveOrNull("size_bytes")?.longOrNull,
                sourceKey = obj.primitiveOrNull("source_key")?.content?.takeIf { it.isNotBlank() },
                pageCount = obj.primitiveOrNull("page_count")?.intOrNull
            )
        }
    }.getOrElse { emptyList() }
}

/**
 * The value at [key] when it is a JSON primitive other than null. A JSON null
 * reads as absent rather than as the string "null".
 */
private fun JsonObject.primitiveOrNull(key: String): JsonPrimitive? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }

/**
 * A persisted message as a history turn for the retrieval-server. Images
 * replay as image blocks; every other attachment goes under `files`: an
 * assistant's attachments are files its tools generated, a user's are
 * documents they uploaded.
 */
fun Message.toConversationMessage(): ConversationMessage =
    ConversationMessage(
        role = role,
        content = text,
        images = attachments.toImageRefs(),
        toolCalls = toolCallsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() },
        toolResults = toolResultsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() },
        files = attachments.toFileRefs(if (role == "assistant") FileOrigin.GENERATED else FileOrigin.UPLOADED)
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
