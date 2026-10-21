package com.genflowly.providers

import com.genflowly.models.retrieval.ConversationMessage
import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.parseRetrievalEvent
import io.ktor.client.*
import io.ktor.client.plugins.timeout
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
    val request_source: String = "conversation",
    val graph_id: String? = null,
    /** End user's per-request reasoning depth; overrides node-config thinking_level on the response generator. */
    val thinking_level: String? = null,
    /** Optional idempotency/rediscovery key; server generates one when null. */
    val run_id: String? = null
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
    private val retrievalServerUrl: String
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
        runId: String? = null
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
     */
    fun streamRun(runId: String, fromSeq: Long = 0): Flow<StreamChunk> = channelFlow {
        logger.info { "Reattaching to durable run $runId from seq $fromSeq" }
        try {
            httpClient.prepareGet("$retrievalServerUrl/runs/$runId/stream?from_seq=$fromSeq") {
                // A durable run can outlive the request timeout; only the socket
                // timeout (gap between events) guards against a stalled tail.
                timeout {
                    requestTimeoutMillis = 1_800_000L
                    socketTimeoutMillis = 300_000L
                }
            }.execute { response ->
                if (!response.status.isSuccess()) {
                    logger.error { "Run stream error for $runId: ${response.status}" }
                    return@execute
                }
                val channel = response.bodyAsChannel()
                while (!channel.isClosedForRead) {
                    val line = channel.readUTF8Line() ?: break
                    if (!line.startsWith("data: ")) continue
                    val data = line.removePrefix("data: ")
                    if (data == "[DONE]") break
                    try {
                        val jsonObj = json.parseToJsonElement(data).jsonObject
                        parseRetrievalEvent(jsonObj)?.let { send(it) }
                    } catch (_: Exception) {
                        // skip malformed SSE chunk
                    }
                }
            }
        } catch (e: Exception) {
            logger.error(e) { "Streaming durable run $runId failed" }
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
