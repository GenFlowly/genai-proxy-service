package com.genflowly.service

import com.genflowly.models.AttachmentRef
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * The S3 keys a message links to, and the rules every retention path (the
 * kept-object claim, the reconciler, the backfill, the purge and the
 * shared-conversation download) applies to them.
 *
 * Keys are only ever taken from what a row stores - never derived from an
 * attachmentId - and every key must match [RETENTION_KEY_PATTERN], because
 * S3Provider itself does not check prefixes. A key that does not match is
 * skipped, and logged by attachment id only.
 */
object RetentionKeys {

    /** customers/{customerId}/attachments/... or customers/{customerId}/agent-fs/... */
    val RETENTION_KEY_PATTERN = Regex("^customers/[^/]+/(attachments|agent-fs)/")

    private val ATTACHMENT_KEY = Regex("^customers/([^/]+)/attachments/([^/]+)$")
    private val CUSTOMER_SEGMENT = Regex("^customers/([^/]+)/")

    /** S3 object tag carrying the retention class. */
    const val RETENTION_TAG = "retention"
    /** Tag naming the conversation that keeps an object. */
    const val CONVERSATION_TAG = "conv"

    const val RETENTION_PENDING = "pending"
    const val RETENTION_KEPT = "kept"

    /** Tag value for an upload that is not linked from a row yet (URL-encoded form for presigning). */
    const val PENDING_TAGGING = "$RETENTION_TAG=$RETENTION_PENDING"

    private const val SOURCE_SUFFIX = ".source.md"
    private const val DERIVED_SUFFIX = ".derived/"

    private val json = Json { ignoreUnknownKeys = true }

    fun isRetentionKey(key: String?): Boolean =
        !key.isNullOrBlank() && RETENTION_KEY_PATTERN.containsMatchIn(key) && '\u0000' !in key

    /** The customer segment of a customers/{customerId}/... key, or null. */
    fun customerIdOfKey(key: String): String? = CUSTOMER_SEGMENT.find(key)?.groupValues?.get(1)

    /**
     * The attachment id of an upload-shaped key
     * (customers/{customerId}/attachments/{attachmentId}), or null for any
     * other shape. Tool-result images carry only their key, so this is how a
     * download request names them.
     */
    fun attachmentIdOfKey(key: String): String? = ATTACHMENT_KEY.matchEntire(key)?.groupValues?.get(2)

    /** Where a generated artifact's Markdown source lives when its row predates sourceKey. */
    fun legacySourceKey(s3Key: String): String = s3Key + SOURCE_SUFFIX

    /** Prefix of the derived sidecars of an object (4.1 writes `<s3Key>.derived/text-v1.json`). */
    fun derivedPrefix(s3Key: String): String = s3Key + DERIVED_SUFFIX

    /** Prefix of a turn's agent-fs scratch namespace. */
    fun scratchPrefix(customerId: String, fsNamespace: String): String =
        "customers/$customerId/agent-fs/$fsNamespace/"

    /**
     * The s3_key of every S3-referenced image in a persisted toolResultsJson
     * ([{"tool_call_id","content","images":[{"s3_key","media_type"}]}]).
     * Inline (omitted) screenshots carry no key. Malformed JSON yields nothing.
     */
    fun toolResultImageKeys(toolResultsJson: String?): List<String> {
        if (toolResultsJson.isNullOrBlank()) return emptyList()
        return runCatching {
            json.parseToJsonElement(toolResultsJson).jsonArray.flatMap { result ->
                ((result as? JsonObject)?.get("images") as? JsonArray).orEmpty().mapNotNull { image ->
                    ((image as? JsonObject)?.get("s3_key") as? JsonPrimitive)
                        ?.takeIf { it !is JsonNull && it.isString }
                        ?.content
                        ?.takeIf { it.isNotBlank() }
                }
            }
        }.getOrElse { emptyList() }
    }

    /**
     * [toolResultsJson] with every image s3_key replaced through [rename]
     * (keys absent from it are kept). Everything else is preserved as is.
     */
    fun rewriteToolResultImageKeys(toolResultsJson: String, rename: Map<String, String>): String {
        if (rename.isEmpty()) return toolResultsJson
        val root = runCatching { json.parseToJsonElement(toolResultsJson).jsonArray }.getOrNull()
            ?: return toolResultsJson
        val rewritten = JsonArray(root.map { result ->
            val obj = result as? JsonObject ?: return@map result
            val images = obj["images"] as? JsonArray ?: return@map result
            JsonObject(obj + ("images" to JsonArray(images.map { image ->
                val imageObj = image as? JsonObject ?: return@map image
                val key = (imageObj["s3_key"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val newKey = key?.let { rename[it] } ?: return@map image
                JsonObject(imageObj + ("s3_key" to JsonPrimitive(newKey)))
            })))
        })
        return rewritten.toString()
    }

    /**
     * The exact keys one message links to: every attachment's s3Key, its
     * sourceKey (or, for a generated file on an assistant message that
     * predates sourceKey, the legacy `<s3Key>.source.md`, which may not
     * exist), and every toolResultsJson image key. Malformed keys are dropped
     * and reported through [onMalformed] with the attachment id only.
     */
    fun messageKeys(
        role: String?,
        attachments: List<AttachmentRef>,
        toolResultsJson: String?,
        onMalformed: (attachmentId: String) -> Unit = {}
    ): MessageKeys {
        val exact = linkedSetOf<String>()
        val optional = linkedSetOf<String>()
        for (ref in attachments) {
            if (!isRetentionKey(ref.s3Key)) {
                onMalformed(ref.attachmentId)
                continue
            }
            exact += ref.s3Key
            val source = ref.sourceKey
            when {
                source != null && isRetentionKey(source) -> exact += source
                source != null -> onMalformed(ref.attachmentId)
                role == "assistant" -> optional += legacySourceKey(ref.s3Key)
            }
        }
        for (key in toolResultImageKeys(toolResultsJson)) {
            if (isRetentionKey(key)) exact += key
            else onMalformed(attachmentIdOfKey(key) ?: "tool-result-image")
        }
        optional.removeAll(exact)
        return MessageKeys(exact = exact, optional = optional)
    }
}

/**
 * Keys a message links to. [exact] keys are expected to exist; [optional]
 * keys (legacy source sidecars) may not, and a missing one is not an error.
 */
data class MessageKeys(
    val exact: Set<String>,
    val optional: Set<String>
) {
    val all: Set<String> get() = exact + optional
}
