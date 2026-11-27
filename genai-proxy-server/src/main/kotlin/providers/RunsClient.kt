package com.genflowly.providers

import com.genflowly.models.retrieval.ConversationMessage
import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.STOP_REASON_INTERRUPTED
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.parseRetrievalEvent
import io.ktor.client.*
import io.ktor.client.plugins.timeout
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KLogger

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
    val raw_data: RunRawData,
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
    val memory_context: MemoryContext? = null,
    val request_source: String = "conversation",
    val graph_id: String? = null,
    /** End user's per-request reasoning depth; overrides node-config thinking_level on the response generator. */
    val thinking_level: String? = null,
    /** Optional idempotency/rediscovery key; server generates one when null. */
    val run_id: String? = null,
    val entitlements: EntitlementsPayload? = null,
    /** Same semantics as RetrievalAgentPayload.turn_id. */
    val turn_id: String? = null
)

@Serializable
private data class RunRawData(
    val query_data: String,
    val top_n: Int = 3,
    val images: List<ImageRef> = emptyList(),
    /** Non-image documents (PDFs) attached to the current-turn query */
    val files: List<FileRef> = emptyList()
)

/** Status snapshot of a durable run (GET /runs/{id}). */
data class RunStatus(
    val runId: String,
    /** DBOS workflow status: ENQUEUED / PENDING / SUCCESS / ERROR / CANCELLED / … */
    val status: String,
    val lastSeq: Long,
    val error: String? = null
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
    /** How long [streamRun] keeps reconnecting without receiving an event. A
     *  retrieval-server restart takes ~15 s; this spans a few back-to-back ones. */
    private val reconnectWindowMillis: Long = 180_000L,
    private val reconnectBackoffMillis: (attempt: Int) -> Long = { attempt -> minOf(1_000L shl minOf(attempt, 4), 10_000L) }
) {
    /**
     * Starts a durable run and returns its id, or null on failure (caller may
     * fall back to the stateless stream). Credentials are deliberately omitted.
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
        queryFiles: List<FileRef> = emptyList(),
        tools: List<PayloadToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<PayloadToolResult> = emptyList(),
        responseSchema: JsonObject? = null,
        memoryEnabled: Boolean = false,
        requestSource: String = "conversation",
        graphId: String? = null,
        thinkingLevel: String? = null,
        runId: String? = null,
        memoryContext: MemoryContext? = null,
        entitlements: com.genflowly.models.CustomerEntitlements? = null,
        turnId: String? = null
    ): String? {
        val payload = json.encodeToString(
            RunStartPayload(
                customer_id = customerId,
                client = client,
                data_type = "text",
                raw_data = RunRawData(query_data = query, images = queryImages, files = queryFiles),
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
                memory_context = memoryContext.takeIf { memoryEnabled },
                request_source = requestSource,
                graph_id = graphId,
                thinking_level = thinkingLevel,
                run_id = runId,
                entitlements = entitlements?.let(EntitlementsPayload::of),
                turn_id = turnId
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
            val id = json.parseToJsonElement(response.bodyAsText()).jsonObject["run_id"]?.jsonPrimitive?.content
            logger.info { "Started durable run $id for customer $customerId (provider $llmProvider, graphId $graphId)" }
            id
        } catch (e: Exception) {
            logger.error(e) { "Error starting durable run for customer $customerId" }
            null
        }
    }

    /**
     * Subscribes to (or reattaches to) a run's event stream as a
     * [Flow]<[StreamChunk]>, replaying from [fromSeq] (0 = from the start). The
     * SSE reader mirrors RetrievalServerClient.retrieveAndGenerateStream so the
     * downstream mapping is identical.
     *
     * The run outlives this connection: when the retrieval-server drops it
     * (crash, OOM kill, redeploy) the stream reconnects from the last relayed
     * seq until [reconnectWindowMillis] passes without progress. A rerun after
     * DBOS recovery arrives as [StreamChunk.RunRestarted]; if the rerun then
     * streams no text (completed LLM steps replay memoized), the terminal
     * event's generated_response is emitted as the content. A run that can't
     * be reached again, or ends without its terminal event, ends on
     * [STOP_REASON_INTERRUPTED].
     */
    fun streamRun(runId: String, fromSeq: Long = 0): Flow<StreamChunk> = channelFlow {
        logger.info { "Reattaching to durable run $runId from seq $fromSeq" }
        var lastSeq = fromSeq
        var restarted = false
        var streamedSinceRestart = false
        var sawTerminal = false
        var sawDone = false
        var attempt = 0
        var lastProgressAt = System.currentTimeMillis()
        while (true) {
            try {
                httpClient.prepareGet("$retrievalServerUrl/runs/$runId/stream?from_seq=$lastSeq") {
                    // A durable run can outlive the request timeout; only the socket
                    // timeout (gap between events) guards against a stalled tail.
                    timeout {
                        requestTimeoutMillis = 1_800_000L
                        socketTimeoutMillis = 300_000L
                    }
                }.execute { response ->
                    if (!response.status.isSuccess()) {
                        logger.warn { "Run stream error for $runId: ${response.status}" }
                        return@execute
                    }
                    val channel = response.bodyAsChannel()
                    var eventSeq: Long? = null
                    while (!channel.isClosedForRead) {
                        val line = channel.readUTF8Line() ?: break
                        if (line.startsWith("id: ")) {
                            eventSeq = line.removePrefix("id: ").trim().toLongOrNull()
                            continue
                        }
                        if (!line.startsWith("data: ")) continue
                        val data = line.removePrefix("data: ")
                        if (data == "[DONE]") {
                            sawDone = true
                            break
                        }
                        val event = try {
                            json.parseToJsonElement(data).jsonObject
                        } catch (_: Exception) {
                            null // skip malformed SSE chunk
                        }
                        when {
                            event == null -> {}
                            event.containsKey("run_restarted") -> {
                                restarted = true
                                streamedSinceRestart = false
                                send(StreamChunk.RunRestarted)
                            }
                            event.containsKey("status") && event.containsKey("run_id") -> {
                                sawTerminal = true
                                val answer = (event["generated_response"] as? JsonPrimitive)?.contentOrNull
                                if (restarted && !streamedSinceRestart && !answer.isNullOrEmpty()) {
                                    send(StreamChunk.Content(answer))
                                }
                                parseRetrievalEvent(event)?.let { send(it) }
                            }
                            else -> parseRetrievalEvent(event)?.let { chunk ->
                                if (chunk is StreamChunk.Content) streamedSinceRestart = true
                                if (chunk is StreamChunk.ContentReset) streamedSinceRestart = false
                                send(chunk)
                            }
                        }
                        eventSeq?.let { lastSeq = it }
                        eventSeq = null
                        attempt = 0
                        lastProgressAt = System.currentTimeMillis()
                    }
                }
            } catch (e: CancellationException) {
                // The user's Stop (GenerationOrchestrator.cancelGeneration) cancels the
                // relay mid-read. That's not a failed run; rethrow so it stays a cancellation.
                throw e
            } catch (e: Exception) {
                logger.warn { "Stream of durable run $runId dropped after seq $lastSeq: ${e.message}" }
            }
            if (sawTerminal) break
            if (sawDone) {
                // The run went terminal without publishing its outcome (an
                // exception in the workflow, or recovery attempts exhausted). A
                // user cancel also ends this way and is already handled upstream.
                if (getRunStatus(runId)?.status != "CANCELLED") {
                    logger.error { "Durable run $runId ended without its terminal event" }
                    send(StreamChunk.StopReason(STOP_REASON_INTERRUPTED))
                }
                break
            }
            if (System.currentTimeMillis() - lastProgressAt >= reconnectWindowMillis) {
                logger.error { "Durable run $runId unreachable since seq $lastSeq — giving up" }
                send(StreamChunk.StopReason(STOP_REASON_INTERRUPTED))
                break
            }
            delay(reconnectBackoffMillis(attempt++))
        }
    }.flowOn(Dispatchers.IO)

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

    /** Fetches a run's status/result (GET /runs/{id}); null if unknown/unreachable. */
    suspend fun getRunStatus(runId: String): RunStatus? = try {
        val response = httpClient.get("$retrievalServerUrl/runs/$runId")
        if (!response.status.isSuccess()) {
            null
        } else {
            val root = json.parseToJsonElement(response.bodyAsText()).jsonObject
            RunStatus(
                runId = runId,
                status = root["status"]?.jsonPrimitive?.content ?: "UNKNOWN",
                lastSeq = root["last_seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                error = root["error"]?.jsonPrimitive?.content
            )
        }
    } catch (e: Exception) {
        logger.warn { "Failed to fetch status for durable run $runId: ${e.message}" }
        null
    }
}
