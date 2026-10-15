package com.genflowly.providers

import com.genflowly.models.retrieval.ConversationMessage
import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.RESPONSE_INTERRUPTED_MESSAGE
import com.genflowly.models.retrieval.RUN_STREAM_LOST_ERROR_TYPE
import com.genflowly.models.retrieval.RawData
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.parseRetrievalEvent
import io.ktor.client.*
import io.ktor.client.plugins.timeout
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KLogger
import java.util.UUID

/**
 * Payload for POST /runs — the retrieval-server's durable run request. Identical
 * to the /retrieve agent payload MINUS `llm_credentials` and `stream`: durable
 * runs resolve BYOK keys server-side from DynamoDB by customer_id (so no secret
 * is ever sent or checkpointed — DURABLE_AGENTS_DBOS_PLAN §5.5), and are always
 * streamed via the reattachable /runs/{id}/stream.
 */
@Serializable
private data class RunStartPayload(
    val customer_id: String,
    val client: String,
    val data_type: String,
    val raw_data: RawData,
    val llm_provider: String,
    val llm_model: String,
    val llm_max_tokens: Int,
    val conversation_history: List<ConversationMessage> = emptyList(),
    val system_prompt: String? = null,
    val agentic: Boolean = true,
    val tools: List<PayloadToolDefinition> = emptyList(),
    val tool_choice: String? = null,
    val tool_results: List<PayloadToolResult> = emptyList(),
    val response_schema: JsonObject? = null,
    val memory_enabled: Boolean = false,
    val request_source: String = "conversation",
    val graph_id: String? = null,
    /** End user's per-request reasoning depth; overrides node-config thinking_level on the response generator. */
    val thinking_level: String? = null,
    /**
     * The run's id, minted by the proxy once per start. The workflow runs
     * under it, so a retried POST with the same body returns the existing
     * run instead of starting a second one.
     */
    val run_id: String
)

/** DBOS workflow statuses after which a run publishes nothing more (routes/runs.py _TERMINAL_STATES). */
internal val TERMINAL_RUN_STATUSES = setOf(
    "SUCCESS", "ERROR", "CANCELLED", "RETRIES_EXCEEDED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
)

/** [RunStatus.status] of a run the retrieval-server does not know: GET /runs/{id} returned 404. */
const val RUN_NOT_FOUND = "NOT_FOUND"

/** Status snapshot of a durable run (GET /runs/{id}). */
data class RunStatus(
    val runId: String,
    /** DBOS workflow status: ENQUEUED / PENDING / SUCCESS / ERROR / CANCELLED / …, or [RUN_NOT_FOUND]. */
    val status: String,
    val lastSeq: Long,
    val error: String? = null
) {
    /** The retrieval-server does not know the run, so it will never publish anything. */
    val notFound: Boolean get() = status == RUN_NOT_FOUND

    /** No event will ever come: the run reached a terminal status, or the server does not know it. */
    val isOver: Boolean get() = notFound || status in TERMINAL_RUN_STATUSES
}

/** The `status` values of a run's terminal summary row (runs.py, run_events.failure_events). */
private val TERMINAL_EVENT_STATUSES = setOf("completed", "error")

/**
 * A run's terminal event: its summary row, `{"status": "completed" | "error",
 * "run_id": ..., ...}`, the last row a run publishes. Other events carry no
 * top-level `status`.
 */
private fun isTerminalRunEvent(event: JsonObject): Boolean =
    (event["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content in TERMINAL_EVENT_STATUSES

/** Where a run's stream stands across re-attach attempts. */
private class RunCursor(
    /** SSE id (run_events seq) of the last event emitted; a re-attach asks for the rows after it. */
    var lastSeq: Long
) {
    /** The run's terminal event was emitted: the stream is complete. */
    var terminal = false

    /**
     * awaiting_input payloads already emitted. A run recovered after a restart
     * replays from the start (after a content_reset row) and publishes its
     * earlier input requests again; those repeats are dropped.
     */
    val awaitingInputs = mutableSetOf<String>()
}

/** How one attempt at a run's stream ended. */
private class AttachOutcome(
    /** The server ended the stream itself (`[DONE]`) rather than the connection failing. */
    val serverEnded: Boolean,
    /** An event or a keepalive comment arrived: the tail was alive. */
    val receivedAny: Boolean
)

/**
 * Client for the retrieval-server's durable agent-run API (POST /runs,
 * GET /runs/{id}/stream, POST /runs/{id}/resume, POST /runs/{id}/cancel,
 * GET /runs/{id}). Sibling of [RetrievalServerClient]; reuses the same Ktor
 * client, base URL, and the shared [parseRetrievalEvent] so the reattach stream
 * yields the identical [StreamChunk] vocabulary as the stateless /retrieve
 * stream — callers forward it unchanged.
 */
class RunsClient(
    private val logger: KLogger,
    private val json: Json,
    private val httpClient: HttpClient,
    private val retrievalServerUrl: String,
    /** Waits between re-attach attempts after a run's stream is lost; the last one repeats. */
    private val reattachBackoffMs: List<Long> = listOf(2_000L, 4_000L, 8_000L, 16_000L, 30_000L),
    /**
     * How long re-attaching may go on while nothing arrives from the run's
     * tail. Covers a retrieval-server restart plus the run's recovery.
     */
    private val reattachDeadlineMs: Long = 10 * 60_000L
) {
    init {
        require(reattachBackoffMs.isNotEmpty()) { "reattachBackoffMs must not be empty" }
    }

    /**
     * Starts a durable run and returns its id, or null on failure (caller may
     * fall back to the stateless stream). Credentials are deliberately omitted.
     *
     * The run id is minted here, once per call and before the POST, so the
     * shared client's automatic retries resend the same id and DBOS treats a
     * repeat as the existing run. It is never derived from the turn's response
     * message id: Regenerate resends the same turn and must start a new run.
     */
    suspend fun startRun(
        customerId: String,
        client: String,
        query: String,
        llmProvider: String,
        llmModel: String,
        llmMaxTokens: Int = 4096,
        conversationHistory: List<ConversationMessage> = emptyList(),
        systemPrompt: String? = null,
        agentic: Boolean = true,
        queryImages: List<ImageRef> = emptyList(),
        tools: List<PayloadToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<PayloadToolResult> = emptyList(),
        responseSchema: JsonObject? = null,
        memoryEnabled: Boolean = false,
        requestSource: String = "conversation",
        graphId: String? = null,
        thinkingLevel: String? = null,
        /** Non-image files attached to the current turn (RawData.files). */
        queryFiles: List<FileRef> = emptyList(),
        /** First language tag of the browser's Accept-Language (RawData.locale). */
        locale: String? = null,
        /** Scratch namespace minted for this request and vendor (RawData.fs_namespace). */
        fsNamespace: String? = null
    ): String? {
        val runId = "run_" + UUID.randomUUID().toString().replace("-", "")
        val payload = json.encodeToString(
            RunStartPayload(
                customer_id = customerId,
                client = client,
                data_type = "text",
                raw_data = RawData(
                    queryData = query,
                    images = queryImages,
                    files = queryFiles,
                    locale = locale,
                    fsNamespace = fsNamespace
                ),
                llm_provider = llmProvider,
                llm_model = llmModel,
                llm_max_tokens = llmMaxTokens,
                conversation_history = conversationHistory,
                system_prompt = systemPrompt?.takeIf { it.isNotBlank() },
                agentic = agentic,
                tools = tools,
                tool_choice = toolChoice,
                tool_results = toolResults,
                response_schema = responseSchema,
                memory_enabled = memoryEnabled,
                request_source = requestSource,
                graph_id = graphId,
                thinking_level = thinkingLevel,
                run_id = runId
            )
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/runs") {
                contentType(ContentType.Application.Json)
                setBody(payload)
                timeout { requestTimeoutMillis = 30_000L }
            }
            if (!response.status.isSuccess()) {
                val errBody = response.bodyAsText()
                logger.error { "Failed to start durable run (${response.status}): $errBody" }
                return null
            }
            val id = runCatching {
                json.parseToJsonElement(response.bodyAsText()).jsonObject["run_id"]?.jsonPrimitive?.content
            }.getOrNull() ?: runId
            logger.info { "Started durable run $id for customer $customerId (provider $llmProvider, graphId $graphId)" }
            id
        } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            logger.error(e) { "Error starting durable run $runId for customer $customerId" }
            // The POST may have reached the server although its response was
            // lost (a timeout, a reset): the run then exists under the id minted
            // above and is followed, instead of a second generation starting.
            getRunStatus(runId)?.takeUnless { it.notFound }?.let {
                logger.info { "Durable run $runId exists despite the failed start (${it.status}); following it" }
                runId
            }
        }
    }

    /**
     * Follows a run's events as a [Flow]<[StreamChunk]>, from after [fromSeq]
     * (0 = from the start) until its terminal event, the summary row
     * `{"status": "completed" | "error", ...}`.
     *
     * A stream that ends without that event — EOF, a socket timeout, a non-2xx
     * response, or a `[DONE]` with no terminal event before it — is re-attached
     * from the last SSE id received (the server sends rows with seq > from_seq,
     * so nothing is replayed twice), waiting [reattachBackoffMs] between
     * attempts and checking GET /runs/{id} each time. A run DBOS reports
     * finished gets drained once more; an unknown run (404) is given up at
     * once. When the run is given up, or nothing has arrived from its tail for
     * [reattachDeadlineMs], the flow ends with a [StreamChunk.Error] of type
     * [RUN_STREAM_LOST_ERROR_TYPE]: the caller must treat the turn as failed.
     */
    fun streamRun(runId: String, fromSeq: Long = 0): Flow<StreamChunk> = channelFlow {
        logger.info { "Reattaching to durable run $runId from seq $fromSeq" }
        val cursor = RunCursor(lastSeq = fromSeq)
        var lastHeardAt = System.nanoTime()
        var backoffStep = 0
        // GET /runs/{id} reported a terminal status: the next attempt drains the
        // remaining rows, and a clean end without the terminal event is final.
        var runFinished = false
        while (true) {
            val outcome = attachOnce(runId, cursor) { send(it) }
            if (cursor.terminal) return@channelFlow
            if (runFinished && outcome.serverEnded) break
            if (outcome.receivedAny) {
                lastHeardAt = System.nanoTime()
                backoffStep = 0
            }
            val remainingMs = reattachDeadlineMs - (System.nanoTime() - lastHeardAt) / 1_000_000
            if (remainingMs <= 0) break
            delay(minOf(reattachBackoffMs[minOf(backoffStep, reattachBackoffMs.lastIndex)], remainingMs))
            backoffStep++
            val status = getRunStatus(runId) ?: continue
            if (status.notFound) break
            if (status.isOver) runFinished = true
        }
        logger.warn { "Durable run $runId: stream lost after seq ${cursor.lastSeq} without a terminal event" }
        send(StreamChunk.Error(RESPONSE_INTERRUPTED_MESSAGE, RUN_STREAM_LOST_ERROR_TYPE))
    }.flowOn(Dispatchers.IO)

    /**
     * One GET /runs/{id}/stream from after [cursor]'s lastSeq. Emits each event's
     * chunk, then moves lastSeq to the event's SSE id, and marks the terminal
     * event (stopping there). Never throws, except to propagate the caller's
     * own cancellation.
     */
    private suspend fun attachOnce(
        runId: String,
        cursor: RunCursor,
        emit: suspend (StreamChunk) -> Unit
    ): AttachOutcome {
        var serverEnded = false
        var receivedAny = false
        try {
            httpClient.prepareGet("$retrievalServerUrl/runs/$runId/stream?from_seq=${cursor.lastSeq}") {
                // A durable run can outlive the request timeout; only the socket
                // timeout (gap between lines; the tail sends keepalive comments
                // while idle) guards against a stalled tail. Either ends this
                // attempt, not the stream.
                timeout {
                    requestTimeoutMillis = 1_800_000L
                    socketTimeoutMillis = 300_000L
                }
            }.execute { response ->
                if (!response.status.isSuccess()) {
                    logger.warn { "Run stream for $runId returned ${response.status}" }
                    return@execute
                }
                val channel = response.bodyAsChannel()
                var eventId: Long? = null
                while (true) {
                    val line = channel.readUTF8Line() ?: break
                    if (line.startsWith("id:")) {
                        eventId = line.removePrefix("id:").trim().toLongOrNull()
                        continue
                    }
                    // ": keepalive" comments, sent while the run is idle, only
                    // show that the tail is alive; blank lines end an event.
                    if (line.startsWith(":")) receivedAny = true
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").removePrefix(" ")
                    if (data == "[DONE]") {
                        serverEnded = true
                        return@execute
                    }
                    receivedAny = true
                    val event = runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull()
                    if (event != null) {
                        val chunk = parseRetrievalEvent(event)
                        if (chunk is StreamChunk.AwaitingInput && !cursor.awaitingInputs.add(chunk.json)) {
                            logger.info { "Durable run $runId: dropping a replayed awaiting_input" }
                        } else {
                            chunk?.let { emit(it) }
                        }
                        if (isTerminalRunEvent(event)) cursor.terminal = true
                    }
                    // Failure frames written by the tail carry no id: only rows advance the cursor.
                    eventId?.let { cursor.lastSeq = it }
                    eventId = null
                    if (cursor.terminal) return@execute
                }
            }
        } catch (e: Exception) {
            currentCoroutineContext().ensureActive()
            logger.warn { "Run stream for $runId dropped after seq ${cursor.lastSeq}: ${e::class.simpleName}: ${e.message}" }
        }
        return AttachOutcome(serverEnded, receivedAny)
    }

    /**
     * Delivers client-tool results / human input to a waiting run
     * (POST /runs/{id}/resume). The in-graph consumer arrives in P2; this wires
     * the durable delivery channel. [resultsJson] is sent as the request body.
     */
    suspend fun resumeRun(runId: String, resultsJson: String): Boolean = try {
        val response = httpClient.post("$retrievalServerUrl/runs/$runId/resume") {
            contentType(ContentType.Application.Json)
            setBody(resultsJson)
        }
        response.status.isSuccess().also {
            if (!it) logger.warn { "Resume run $runId returned ${response.status}" }
        }
    } catch (e: Exception) {
        logger.error(e) { "Failed to resume durable run $runId" }
        false
    }

    /** Cancels a run and drops its event channel (POST /runs/{id}/cancel). */
    suspend fun cancelRun(runId: String): Boolean = try {
        val response = httpClient.post("$retrievalServerUrl/runs/$runId/cancel")
        response.status.isSuccess().also {
            if (!it) logger.warn { "Cancel run $runId returned ${response.status}" }
        }
    } catch (e: Exception) {
        logger.error(e) { "Failed to cancel durable run $runId" }
        false
    }

    /**
     * Fetches a run's status/result (GET /runs/{id}). A run the server does not
     * know (404) reads as status [RUN_NOT_FOUND]; null when the status could
     * not be read (server unreachable or failing).
     */
    suspend fun getRunStatus(runId: String): RunStatus? = try {
        val response = httpClient.get("$retrievalServerUrl/runs/$runId")
        when {
            response.status == HttpStatusCode.NotFound -> RunStatus(runId = runId, status = RUN_NOT_FOUND, lastSeq = 0L)
            !response.status.isSuccess() -> null
            else -> {
                val root = json.parseToJsonElement(response.bodyAsText()).jsonObject
                RunStatus(
                    runId = runId,
                    status = root["status"]?.jsonPrimitive?.content ?: "UNKNOWN",
                    lastSeq = root["last_seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    error = (root["error"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                )
            }
        }
    } catch (e: Exception) {
        currentCoroutineContext().ensureActive()
        logger.warn { "Failed to fetch status for durable run $runId: ${e.message}" }
        null
    }
}
