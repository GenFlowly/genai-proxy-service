package com.genflowly.models.retrieval

import com.genflowly.models.AIVendor
import com.genflowly.models.ModelCatalogEntry
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Exchange types for the Python retrieval-server: streaming chunks, generation
 * results and the tool/image/file payload shapes shared between
 * RetrievalServerClient, RunsClient and their callers. Wire-format payloads
 * that never leave a client remain private to that client.
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
     * [{"artifact_id","key","media_type","filename","size_bytes","source_key",
     * "page_count"}]. Emitted when the graph's TOOL_EXECUTOR node completes.
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
        val tokensWrittenToCache: Int = 0,
        /** Reasoning/thinking tokens — a subset of [outputTokens], billed at the output rate. */
        val reasoningTokens: Int = 0
    ) : StreamChunk()

    /**
     * Generation failed mid-stream: the retrieval server's concise,
     * user-facing description of the vendor error (quota exceeded, key
     * rejected, ...). errorType is its machine class (rate_limit, auth,
     * context_length, model_not_found, provider_error; for a failed durable
     * run also run_lost, resume_timeout, runaway or error, and
     * [RUN_STREAM_LOST_ERROR_TYPE] when the proxy lost the run's stream).
     */
    data class Error(val message: String, val errorType: String? = null) : StreamChunk()

    /**
     * A durable run paused on an in-graph interrupt() and is awaiting human /
     * client input (DURABLE_AGENTS_DBOS_PLAN §5.4). Raw JSON of the interrupt
     * payload: {"type","node","prompt",...}. Deliver the response via the runs
     * client's resume(). Only emitted on the durable /runs reattach stream.
     */
    data class AwaitingInput(val json: String) : StreamChunk()

    /**
     * Transient progress while a tool's arguments are being written, raw JSON
     * of the event's object: {"tool": "generate_pdf", "chars": 1234}. Relayed
     * to the client only: never captured into thinking steps, never persisted.
     */
    data class Progress(val json: String) : StreamChunk()
}

/** Shown when a run's terminal summary reports status "error" without any error text. */
internal const val RUN_FAILED_FALLBACK_MESSAGE = "The response could not be completed."

/**
 * User-facing text of a turn whose stream was cut off before it ended: a
 * durable run whose stream could not be re-attached before the deadline, or a
 * stream that failed after the turn generated a file.
 */
internal const val RESPONSE_INTERRUPTED_MESSAGE = "The response was interrupted before it finished. Please try again."

/**
 * errorType of the [StreamChunk.Error] that ends a durable run's stream when
 * the run never delivered its terminal event and could not be re-attached
 * (contract C5). The turn failed from the user's point of view, but the run
 * itself may still be going.
 */
internal const val RUN_STREAM_LOST_ERROR_TYPE = "stream_lost"

/**
 * Map one retrieval-server SSE event object (the parsed JSON of a `data: {...}`
 * line) to a StreamChunk, or null when it carries no recognized event key (or
 * a recognized key with an empty/blank payload that should be skipped).
 *
 * Shared by the streaming `/retrieve` reader and the durable `/runs` reattach
 * stream: both transports emit the identical event vocabulary
 * (content / thinking_step / thinking / thinking_duration_ms / web_sources /
 * generated_artifacts / tool_calls / awaiting_input / progress / error /
 * usage). (`awaiting_input` is durable-runs-only — the /retrieve stream never
 * emits it.) Unknown keys, such as the `{"keepalive": true}` lines sent during
 * silences, map to null.
 *
 * A failure is checked first, before every content key: a failed run's
 * terminal summary ({"status": "error", "error": ..., "generated_artifacts":
 * [...], ...}) carries other recognized keys too, and must still read as the
 * error. Otherwise the first recognized key wins, in the order below.
 */
fun parseRetrievalEvent(jsonObj: JsonObject): StreamChunk? = failureOf(jsonObj) ?: when {
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
    jsonObj.containsKey("progress") -> (jsonObj["progress"] as? JsonObject)?.let { StreamChunk.Progress(it.toString()) }
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

/**
 * The Error an event reports, or null: an `error` that is a non-blank string
 * (a mid-stream vendor failure, a standalone run-failure row, or a failed
 * run's terminal summary), or a terminal summary whose `status` is "error"
 * even without error text. A null or blank `error`, as on a successful
 * summary, is not a failure.
 */
private fun failureOf(jsonObj: JsonObject): StreamChunk.Error? {
    val message = jsonObj.stringOrNull("error")?.takeIf { it.isNotBlank() }
    if (message == null && jsonObj.stringOrNull("status") != "error") return null
    return StreamChunk.Error(
        message = message ?: RUN_FAILED_FALLBACK_MESSAGE,
        errorType = jsonObj.stringOrNull("error_type")?.takeIf { it.isNotBlank() }
    )
}

/** The value at [key] when it is a JSON string; null for a JSON null, a number, an object or an array. */
private fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

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

/** Where a [FileRef]'s file came from. */
@Serializable
enum class FileOrigin {
    /** Produced by a built-in tool on an assistant turn (e.g. a generated PDF). */
    @SerialName("generated") GENERATED,
    /** Attached by the user to their message. */
    @SerialName("uploaded") UPLOADED
}

/**
 * A non-image file of the conversation, passed to the retrieval-server so the
 * model knows which files exist and tools can address them. Tools read the
 * file by the stored [s3Key] exactly as given: in a shared conversation it can
 * sit under another participant's prefix, so it is never rebuilt from
 * [attachmentId].
 */
@Serializable
data class FileRef(
    @SerialName("attachment_id") val attachmentId: String,
    @SerialName("s3_key") val s3Key: String,
    @SerialName("media_type") val mediaType: String,
    val filename: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long? = null,
    val origin: FileOrigin
)

/**
 * The current turn's `raw_data` in /retrieve and POST /runs requests. Fields
 * left at their empty or null defaults are omitted by the proxy's Json
 * (encodeDefaults off), so a retrieval-server that predates them never sees
 * them.
 */
@Serializable
data class RawData(
    @SerialName("query_data") val queryData: String,
    @SerialName("top_n") val topN: Int = 3,
    /** Images attached to the current-turn query */
    val images: List<ImageRef> = emptyList(),
    /** Non-image files attached to the current-turn query */
    val files: List<FileRef> = emptyList(),
    /** First language tag of the browser's Accept-Language (e.g. "en-US"); null when unknown */
    val locale: String? = null,
    /**
     * Scratch namespace the proxy minted for this request and vendor, under
     * which the turn's agent-fs objects are written; null lets the
     * retrieval-server mint its own.
     */
    @SerialName("fs_namespace") val fsNamespace: String? = null
)

@Serializable
data class ConversationMessage(
    val role: String,
    val content: String,
    val images: List<ImageRef> = emptyList(),
    /** Assistant turns: [{"id","name","args"}] tool calls the model made */
    @SerialName("tool_calls") val toolCalls: kotlinx.serialization.json.JsonElement? = null,
    /** User turns: [{"tool_call_id","content"}] results the caller executed */
    @SerialName("tool_results") val toolResults: kotlinx.serialization.json.JsonElement? = null,
    /**
     * Non-image files of this turn: generated files on assistant turns
     * (origin generated), uploaded documents on user turns (origin uploaded).
     */
    val files: List<FileRef> = emptyList()
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
