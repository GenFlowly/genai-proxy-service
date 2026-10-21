package com.genflowly.models.retrieval

import com.genflowly.models.AIVendor
import com.genflowly.models.ModelCatalogEntry
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Exchange types for the Python retrieval-server: streaming chunks, generation
 * results and the tool/image payload shapes shared between
 * RetrievalServerClient and its callers. Wire-format payloads that never leave
 * the client remain private to providers/RetrievalServerClient.kt.
 */

sealed class StreamChunk {
    data class Content(val text: String) : StreamChunk()
    /**
     * The generation round that just streamed ended in tool calls executed
     * in-graph — its streamed Content was a tool-call preamble ("Let me look
     * up…"), not answer text, and a fresh generation round follows. Consumers
     * accumulating Content into answer text must discard what they hold: the
     * orchestrator resets its persistence buffer, the web app clears the
     * visible text. The preamble survives in the thinking step's `reasoning`.
     */
    object ContentReset : StreamChunk()
    /**
     * The vendor's raw finish reason for the round that ended the turn
     * (end_turn / stop / max_tokens / refusal / content_filter / …), streamed
     * verbatim so the client can always show why generation stopped — a refusal
     * returns empty content, so without this it would look like a silent blank.
     * Persisted on the Message so it survives a reload.
     */
    data class StopReason(val reason: String) : StreamChunk()
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
     * the generated text: [{"index","title","url"}]. Emitted when a
     * TOOL_EXECUTOR round surfaces citable tool sources (web_search).
     */
    data class WebSources(val json: String) : StreamChunk()
    data class Usage(
        val inputTokens: Int,
        val outputTokens: Int,
        val totalTokens: Int,
        val tokensReadFromCache: Int,
        /** Prompt-cache write (cache_creation) tokens — billed at the cache-write rate. */
        val tokensWrittenToCache: Int = 0,
        /** Reasoning/thinking tokens — a subset of [outputTokens], billed at the output rate. */
        val reasoningTokens: Int = 0
    ) : StreamChunk()

    /**
     * Generation failed mid-stream: the retrieval server's concise,
     * user-facing description of the vendor error (quota exceeded, key
     * rejected, ...). errorType is its machine class (rate_limit, auth,
     * context_length, model_not_found, provider_error).
     */
    data class Error(val message: String, val errorType: String? = null) : StreamChunk()

    /**
     * A durable run paused on an in-graph interrupt() and is awaiting human /
     * client input (DURABLE_AGENTS_DBOS_PLAN §5.4). Raw JSON of the interrupt
     * payload: {"type","node","prompt",...}. Deliver the response via the runs
     * client's resume(). Only emitted on the durable /runs reattach stream.
     */
    data class AwaitingInput(val json: String) : StreamChunk()
}

/**
 * Map one retrieval-server SSE event object (the parsed JSON of a `data: {...}`
 * line) to a StreamChunk, or null when it carries no recognized event key (or
 * a recognized key with an empty/blank payload that should be skipped).
 *
 * Shared by the streaming `/retrieve` reader and the durable `/runs` reattach
 * stream: both transports emit the identical event vocabulary
 * (content / thinking_step / thinking / thinking_duration_ms / web_sources /
 * generated_artifacts / tool_calls / awaiting_input / error / usage). Key
 * precedence and the null/empty guards mirror the original inline reader exactly.
 * (`awaiting_input` is durable-runs-only — the /retrieve stream never emits it.)
 */
fun parseRetrievalEvent(jsonObj: JsonObject): StreamChunk? = when {
    jsonObj.containsKey("content") -> {
        val content = jsonObj["content"]?.jsonPrimitive?.content
        if (!content.isNullOrEmpty()) StreamChunk.Content(content) else null
    }
    jsonObj.containsKey("content_reset") -> StreamChunk.ContentReset
    jsonObj.containsKey("stop_reason") -> {
        val reason = jsonObj["stop_reason"]?.jsonPrimitive?.content
        if (!reason.isNullOrBlank()) StreamChunk.StopReason(reason) else null
    }
    jsonObj.containsKey("thinking_step") ->
        jsonObj["thinking_step"]?.let { StreamChunk.ThinkingStep(it.toString()) }
    jsonObj.containsKey("thinking") -> {
        val thinking = jsonObj["thinking"]?.jsonPrimitive?.content
        if (!thinking.isNullOrEmpty()) StreamChunk.Thinking(thinking) else null
    }
    jsonObj.containsKey("thinking_duration_ms") -> {
        val millis = jsonObj["thinking_duration_ms"]?.jsonPrimitive?.content?.toLongOrNull()
        if (millis != null) StreamChunk.ThinkingDuration(millis) else null
    }
    jsonObj.containsKey("web_sources") -> {
        val webSources = jsonObj["web_sources"]
        if (webSources != null && webSources !is JsonNull) StreamChunk.WebSources(webSources.toString()) else null
    }
    jsonObj.containsKey("generated_artifacts") -> {
        val artifacts = jsonObj["generated_artifacts"]
        if (artifacts != null && artifacts !is JsonNull) StreamChunk.GeneratedArtifacts(artifacts.toString()) else null
    }
    jsonObj.containsKey("tool_calls") -> {
        val toolCalls = jsonObj["tool_calls"]
        if (toolCalls != null && toolCalls !is JsonNull) StreamChunk.ToolCalls(toolCalls.toString()) else null
    }
    jsonObj.containsKey("awaiting_input") -> {
        val payload = jsonObj["awaiting_input"]
        if (payload != null && payload !is JsonNull) StreamChunk.AwaitingInput(payload.toString()) else null
    }
    jsonObj.containsKey("error") -> {
        val message = jsonObj["error"]?.jsonPrimitive?.content
        if (!message.isNullOrBlank()) StreamChunk.Error(
            message = message,
            errorType = jsonObj["error_type"]?.jsonPrimitive?.content
        ) else null
    }
    jsonObj.containsKey("usage") -> {
        val usageObj = jsonObj["usage"]!!.jsonObject
        StreamChunk.Usage(
            inputTokens = usageObj["input_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
            outputTokens = usageObj["output_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
            totalTokens = usageObj["total_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
            tokensReadFromCache = usageObj["cache_read_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
            tokensWrittenToCache = usageObj["cache_creation_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
            reasoningTokens = usageObj["reasoning_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }
    else -> null
}

data class RetrievalResult(
    val text: String?,
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?,
    val tokensReadFromCache: Int?,
    /** Prompt-cache write (cache_creation) tokens — billed at the cache-write rate. */
    val tokensWrittenToCache: Int? = null,
    /** Reasoning/thinking tokens — a subset of outputTokens, billed at the output rate. */
    val reasoningTokens: Int? = null,
    /** JSON array of tool calls the model made, null when it answered directly */
    val toolCallsJson: String? = null,
    /** JSON array of artifacts built-in tools produced (see StreamChunk.GeneratedArtifacts) */
    val generatedArtifactsJson: String? = null,
    /**
     * User-facing reason the turn could not run (e.g. an attachment that could
     * not be decoded as an image), set instead of [text] when the
     * retrieval-server rejected the request with a readable message.
     */
    val errorMessage: String? = null
)

/** Image reference passed to the retrieval-server, which fetches the bytes from S3 itself. */
@Serializable
data class ImageRef(
    @SerialName("s3_key") val s3Key: String,
    @SerialName("media_type") val mediaType: String
)

/**
 * Non-image document (PDF today) passed to the retrieval-server, which fetches
 * the bytes from S3 and feeds the model a native document block, page images,
 * or extracted text depending on the chosen model's capabilities. Carries the
 * display filename so the model and any error message can name the document.
 */
@Serializable
data class FileRef(
    @SerialName("s3_key") val s3Key: String,
    @SerialName("media_type") val mediaType: String,
    val filename: String? = null
)

@Serializable
data class ConversationMessage(
    val role: String,
    val content: String,
    val images: List<ImageRef> = emptyList(),
    /** Non-image documents (PDFs) the user attached on this turn; replayed as a
     *  lightweight note in later turns rather than re-sent in full. */
    val files: List<FileRef> = emptyList(),
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
