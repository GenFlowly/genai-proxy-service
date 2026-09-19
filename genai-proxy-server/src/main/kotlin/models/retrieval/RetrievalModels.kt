package com.genflowly.models.retrieval

import com.genflowly.models.AIVendor
import com.genflowly.models.ModelCatalogEntry
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Exchange types for the Python retrieval-server: streaming chunks, generation
 * results and the tool/image payload shapes shared between
 * RetrievalServerClient and its callers. Wire-format payloads that never leave
 * the client remain private to providers/RetrievalServerClient.kt.
 */

sealed class StreamChunk {
    data class Content(val text: String) : StreamChunk()
    data class Thinking(val text: String) : StreamChunk()
    /**
     * Raw JSON of one structured graph-execution step for the thinking panel:
     * {"node","name","kind","status","label"?,"detail"?,"items"?,"prompt"?,"response"?}
     */
    data class ThinkingStep(val json: String) : StreamChunk()
    /** Request receipt on the retrieval server → first generated token, in ms */
    data class ThinkingDuration(val millis: Long) : StreamChunk()
    /** Raw JSON array of tool calls the model made: [{"id","name","args"}] */
    data class ToolCalls(val json: String) : StreamChunk()
    /**
     * Raw JSON array of files built-in tools produced during the turn (e.g.
     * generated PDFs), already stored in the attachments bucket:
     * [{"artifact_id","key","media_type","filename","size_bytes"}]. Emitted
     * when the graph's TOOL_EXECUTOR node completes.
     */
    data class GeneratedArtifacts(val json: String) : StreamChunk()
    /**
     * Raw JSON array of web-search sources backing the [n] citation markers in
     * the generated text: [{"index","title","url"}]. Emitted once, when the
     * WEB_SEARCH graph node completes.
     */
    data class WebSources(val json: String) : StreamChunk()
    data class Usage(
        val inputTokens: Int,
        val outputTokens: Int,
        val totalTokens: Int,
        val tokensReadFromCache: Int,
        /** Prompt-cache write (cache_creation) tokens — billed at the cache-write rate. */
        val tokensWrittenToCache: Int = 0
    ) : StreamChunk()

    /**
     * Generation failed mid-stream: the retrieval server's concise,
     * user-facing description of the vendor error (quota exceeded, key
     * rejected, ...). errorType is its machine class (rate_limit, auth,
     * context_length, model_not_found, provider_error).
     */
    data class Error(val message: String, val errorType: String? = null) : StreamChunk()
}

data class RetrievalResult(
    val text: String?,
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?,
    val tokensReadFromCache: Int?,
    /** Prompt-cache write (cache_creation) tokens — billed at the cache-write rate. */
    val tokensWrittenToCache: Int? = null,
    /** JSON array of tool calls the model made, null when it answered directly */
    val toolCallsJson: String? = null,
    /** JSON array of artifacts built-in tools produced (see StreamChunk.GeneratedArtifacts) */
    val generatedArtifactsJson: String? = null
)

/** Image reference passed to the retrieval-server, which fetches the bytes from S3 itself. */
@Serializable
data class ImageRef(
    @SerialName("s3_key") val s3Key: String,
    @SerialName("media_type") val mediaType: String
)

@Serializable
data class ConversationMessage(
    val role: String,
    val content: String,
    val images: List<ImageRef> = emptyList(),
    /** Assistant turns: [{"id","name","args"}] tool calls the model made */
    @SerialName("tool_calls") val toolCalls: kotlinx.serialization.json.JsonElement? = null,
    /** User turns: [{"tool_call_id","content"}] results the caller executed */
    @SerialName("tool_results") val toolResults: kotlinx.serialization.json.JsonElement? = null
)

@Serializable
data class PayloadToolDefinition(
    val name: String,
    val description: String = "",
    val parameters: kotlinx.serialization.json.JsonObject? = null,
    val type: String? = null,
    val options: kotlinx.serialization.json.JsonObject? = null
)

@Serializable
data class PayloadToolResult(
    @SerialName("tool_call_id") val toolCallId: String,
    val content: String,
    val images: List<PayloadToolResultImage> = emptyList()
)

@Serializable
data class PayloadToolResultImage(
    val data: String? = null,
    @SerialName("s3_key") val s3Key: String? = null,
    @SerialName("media_type") val mediaType: String = "image/png",
    /** true when a base64 screenshot was stripped at persistence time (history replay) */
    val omitted: Boolean = false
)

/** Per-vendor model metadata as returned by the retrieval-server's /models/metadata. */
data class VendorModelMetadata(
    val vendor: AIVendor,
    val models: List<ModelCatalogEntry>,
    /** Non-null when the vendor fetch failed on the retrieval-server side. */
    val error: String? = null
)
