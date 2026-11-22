package com.genflowly.providers

import com.genflowly.models.AIVendor
import io.ktor.client.*
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.genflowly.models.ModelCatalogEntry
import com.genflowly.models.retrieval.ConversationMessage
import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.VendorModelMetadata
import com.genflowly.models.retrieval.parseRetrievalEvent
import com.genflowly.models.aiVendorFromProviderString
import com.genflowly.models.toProviderString
import mu.KLogger

/**
 * Where, and for which reply, memories are used. The MEMORY node applies
 * Profile memories plus [project_id]'s only, and keys the usage log it writes
 * by [response_message_id] and [turn_started_at], so a retried or failed-over
 * call for the same reply counts each memory once. Sent only when memory is
 * enabled for the request.
 */
@Serializable
data class MemoryContext(
    val project_id: String? = null,
    val conversation_id: String,
    val response_message_id: String,
    val turn_started_at: String,
)

/**
 * The customer's entitlements, so the retrieval-server binds only tools the
 * customer can use: knowledge and memory search need a vector DB and an
 * embedding key, web search needs a web search key. Absent when unknown;
 * every tool is then bound and finds out for itself.
 */
@Serializable
data class EntitlementsPayload(
    val is_vector_db_storing_enabled: Boolean,
    val is_embedding_creation_enabled: Boolean,
    val is_web_search_enabled: Boolean,
) {
    companion object {
        fun of(entitlements: com.genflowly.models.CustomerEntitlements) = EntitlementsPayload(
            is_vector_db_storing_enabled = entitlements.isVectorDbStoringEnabled,
            is_embedding_creation_enabled = entitlements.isEmbeddingCreationEnabled,
            is_web_search_enabled = entitlements.isWebSearchEnabled,
        )
    }
}

@Serializable
private data class RetrievalAgentPayload(
    val customer_id: String,
    val client: String,
    val data_type: String,
    val raw_data: AgentRawData,
    val llm_credentials: Map<String, String>,
    val llm_provider: String,
    val llm_model: String,
    val llm_max_tokens: Int,
    val conversation_history: List<ConversationMessage> = emptyList(),
    val system_prompt: String? = null,
    val stream: Boolean = false,
    val agentic: Boolean = true,
    val tools: List<PayloadToolDefinition> = emptyList(),
    val tool_choice: String? = null,
    val tool_results: List<PayloadToolResult> = emptyList(),
    /** JSON Schema for vendor-enforced structured output; exclusive with tools */
    val response_schema: kotlinx.serialization.json.JsonObject? = null,
    /** Governance decision: MEMORY nodes may inject learned user memories. */
    val memory_enabled: Boolean = false,
    val memory_context: MemoryContext? = null,
    /** Purpose label for llm_request_total{source=...}: "conversation" or a RequestType lowercased. */
    val request_source: String = "conversation",
    /**
     * Explicit agent graph to run instead of the customer's default; access
     * is validated proxy-side (own-or-System) before it reaches this payload.
     */
    val graph_id: String? = null,
    /**
     * End user's per-request reasoning depth ("none"|"low"|"medium"|"high");
     * overrides the response generator's node-config thinking_level.
     */
    val thinking_level: String? = null,
    val entitlements: EntitlementsPayload? = null,
    /**
     * The user message this generation answers. The sibling per-model requests
     * of one turn carry the same id, so the retrieval-server can fetch shareable
     * tool lookups (web search) once per message. Null for regenerations and
     * internal generations, which then share nothing.
     */
    val turn_id: String? = null
)

@Serializable
private data class AgentRawData(
    val query_data: String,
    val top_n: Int = 3,
    /** Images attached to the current-turn query */
    val images: List<ImageRef> = emptyList(),
    /** Non-image documents (PDFs) attached to the current-turn query */
    val files: List<FileRef> = emptyList()
)

// --- /execute-agent-graph wire types ---

@Serializable
private data class ExecuteAgentGraphPayload(
    val graph_id: String,
    val customer_id: String,
    val client: String = "internal",
    val variables: Map<String, String> = emptyMap(),
    val llm_credentials: Map<String, String>,
    val llm_provider: String,
    val llm_model: String,
    val llm_max_tokens: Int = 4096,
    val model_type: String? = null,
    val model_name: String? = null,
    val response_schema: kotlinx.serialization.json.JsonObject? = null,
    /** Purpose label for llm_request_total{source=...}: the RequestType lowercased. */
    val request_source: String = "internal",
    /**
     * Run as a DBOS durable workflow when the retrieval server's durable
     * runtime is up (exactly-once LLM steps; credentials resolved server-side
     * from the customer's stored keys). Only set for customer-key candidates.
     */
    val durable: Boolean = false
)

// --- /models and /validate-key wire types ---

@Serializable
private data class ListModelsVendorCredentials(
    val provider: String,
    val api_key: String,
    val capability: String = "all"
)

@Serializable
private data class ListModelsPayload(val vendors: List<ListModelsVendorCredentials>)

@Serializable
private data class VendorModels(val provider: String, val models: List<String>)

@Serializable
private data class ListModelsResponse(val vendor_models: List<VendorModels>)

// --- /probe-embedding-models wire types ---

@Serializable
private data class ProbeVendorCredentials(val provider: String, val api_key: String)

@Serializable
private data class ProbeModelsPayload(val vendors: List<ProbeVendorCredentials>)

@Serializable
private data class WireVendorProbeResult(
    val provider: String,
    val supported: List<String> = emptyList(),
    val inconclusive: List<String> = emptyList(),
    val error: String? = null
)

@Serializable
private data class ProbeModelsResponse(val vendor_results: List<WireVendorProbeResult>)

/**
 * One vendor's probe outcome: which of its catalog embedding models the given
 * key actually embedded ([supported]), which were transient/uncertain
 * ([inconclusive], keep the prior verdict), and [error] when the key itself
 * failed auth (both lists empty — keep the stored list untouched).
 */
data class VendorProbeResult(
    val provider: String,
    val supported: List<String>,
    val inconclusive: List<String>,
    val error: String?
)

@Serializable
private data class ValidateKeyPayload(val provider: String, val api_key: String)

@Serializable
private data class ValidateKeyResponse(
    val provider: String,
    val valid: Boolean,
    val error: String? = null
)

/** Outcome of a provider key check, with the provider's rejection message. */
data class KeyValidationResult(val valid: Boolean, val error: String? = null)

// --- /voice/calls/* wire types ---

@Serializable
private data class AttachCallPayload(
    val api_key: String,
    val call_id: String,
    val customer_id: String,
    val session_update: kotlinx.serialization.json.JsonObject? = null,
    val webhook_url: String? = null,
    val webhook_secret: String? = null,
)

@Serializable
private data class SendCallEventsPayload(
    val call_id: String,
    val customer_id: String,
    val events: List<kotlinx.serialization.json.JsonObject>,
)

@Serializable
private data class CallRefPayload(val call_id: String, val customer_id: String)

// --- /voice/client-secret wire types ---

@Serializable
private data class RealtimeClientSecretPayload(
    val api_key: String,
    val model: String,
    val instructions: String,
    val voice: String? = null,
    val input_transcription_model: String? = null,
)

@Serializable
private data class RealtimeClientSecretServerResponse(
    val value: String? = null,
    val expires_at: Long? = null,
    val model: String? = null,
    val error: String? = null,
)

/** Outcome of an ephemeral-secret mint; [value] null means it failed with [error]. */
data class RealtimeClientSecretResult(
    val value: String? = null,
    val expiresAt: Long? = null,
    val error: String? = null,
)

// --- /models/metadata wire types ---

@Serializable
private data class MetadataVendorKey(val provider: String, val api_key: String)

@Serializable
private data class ModelMetadataPayload(val vendors: List<MetadataVendorKey>)

@Serializable
private data class ModelMetadataEntry(
    val model: String,
    val max_output_tokens: Int? = null,
    val max_input_tokens: Int? = null,
    // USD per 1M tokens (from LiteLLM's live price map — vendors expose no pricing API)
    val input_cost_per_mtok: Double? = null,
    val output_cost_per_mtok: Double? = null,
    val cache_read_cost_per_mtok: Double? = null,
    val cache_write_cost_per_mtok: Double? = null,
    val input_audio_cost_per_mtok: Double? = null,
    val output_audio_cost_per_mtok: Double? = null,
    val cache_read_audio_cost_per_mtok: Double? = null
)

@Serializable
private data class WireVendorModelMetadata(
    val provider: String,
    val models: List<ModelMetadataEntry>,
    val error: String? = null,
    val auth_failed: Boolean = false
)

@Serializable
private data class ModelMetadataResponse(val vendor_models: List<WireVendorModelMetadata>)

/**
 * The single HTTP/WebSocket client for the Python retrieval-server. All
 * endpoints of that server are reached through this class: /retrieve (batch +
 * SSE stream), /models, /validate-key, /models/metadata, /delete-note-vectors
 * and the /voice WebSocket. No business logic lives here — callers own
 * validation, persistence and policy.
 */
class RetrievalServerClient(
    private val logger: KLogger,
    private val json: Json,
    private val httpClient: HttpClient,
    private val retrievalServerUrl: String
) {
    /** ws(s) URL of the realtime voice endpoint (http -> ws, https -> wss). */
    val voiceWsUrl: String = retrievalServerUrl.replaceFirst("http", "ws") + "/voice"

    /**
     * Opens a WebSocket to the /voice endpoint with unbounded timeouts (voice
     * sessions are long-lived) and runs [handler] on the session.
     */
    suspend fun voiceSession(handler: suspend DefaultClientWebSocketSession.() -> Unit) {
        httpClient.webSocket(voiceWsUrl, request = {
            timeout {
                requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
            }
        }, block = handler)
    }

    private fun buildPayload(
        customerId: String,
        client: String,
        query: String,
        llmCredentials: Map<String, String>,
        llmProvider: String,
        llmModel: String,
        llmMaxTokens: Int,
        conversationHistory: List<ConversationMessage>,
        systemPrompt: String?,
        stream: Boolean,
        agentic: Boolean,
        queryImages: List<ImageRef>,
        queryFiles: List<FileRef>,
        tools: List<PayloadToolDefinition>,
        toolChoice: String?,
        toolResults: List<PayloadToolResult>,
        responseSchema: kotlinx.serialization.json.JsonObject?,
        memoryEnabled: Boolean,
        requestSource: String,
        graphId: String? = null,
        thinkingLevel: String? = null,
        memoryContext: MemoryContext? = null,
        entitlements: com.genflowly.models.CustomerEntitlements? = null,
        turnId: String? = null
    ): String = json.encodeToString(
        RetrievalAgentPayload(
            customer_id = customerId,
            client = client,
            data_type = "text",
            raw_data = AgentRawData(query_data = query, images = queryImages, files = queryFiles),
            llm_credentials = llmCredentials,
            llm_provider = llmProvider,
            llm_model = llmModel,
            llm_max_tokens = llmMaxTokens,
            conversation_history = conversationHistory,
            system_prompt = systemPrompt?.takeIf { it.isNotBlank() },
            stream = stream,
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
            entitlements = entitlements?.let(EntitlementsPayload::of),
            turn_id = turnId
        )
    )

    suspend fun retrieveAndGenerate(
        customerId: String,
        client: String,
        query: String,
        llmCredentials: Map<String, String>,
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
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        memoryEnabled: Boolean = false,
        requestSource: String = "conversation",
        graphId: String? = null,
        thinkingLevel: String? = null,
        memoryContext: MemoryContext? = null,
        entitlements: com.genflowly.models.CustomerEntitlements? = null
    ): RetrievalResult {
        logger.info { "Calling retrieval-server (non-streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}, structured=${responseSchema != null}, graphId=$graphId" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, systemPrompt, stream = false, agentic = agentic, queryImages = queryImages, queryFiles = queryFiles, tools = tools, toolChoice = toolChoice, toolResults = toolResults, responseSchema = responseSchema, memoryEnabled = memoryEnabled, requestSource = requestSource, graphId = graphId, thinkingLevel = thinkingLevel, memoryContext = memoryContext, entitlements = entitlements)
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payload)
                timeout {
                    requestTimeoutMillis = 300_000L
                    socketTimeoutMillis = 300_000L
                }
            }
            if (!response.status.isSuccess()) {
                val errorBody = response.bodyAsText()
                logger.error { "Retrieval server error ${response.status}: $errorBody" }
                return RetrievalResult(null, null, null, null, null, errorMessage = attachmentErrorMessage(errorBody))
            }
            val body = response.bodyAsText()
            val root = json.parseToJsonElement(body).jsonObject
            val text = root["generated_response"]?.jsonPrimitive?.content
            val usageObj = root["usage"]?.jsonObject
            val toolCallsElement = root["tool_calls"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
            val artifactsElement = root["generated_artifacts"]
                ?.takeIf { it is kotlinx.serialization.json.JsonArray && it.isNotEmpty() }
            RetrievalResult(
                text = text,
                inputTokens = usageObj?.get("input_tokens")?.jsonPrimitive?.intOrNull,
                outputTokens = usageObj?.get("output_tokens")?.jsonPrimitive?.intOrNull,
                totalTokens = usageObj?.get("total_tokens")?.jsonPrimitive?.intOrNull,
                tokensReadFromCache = usageObj?.get("cache_read_tokens")?.jsonPrimitive?.intOrNull,
                tokensWrittenToCache = usageObj?.get("cache_creation_tokens")?.jsonPrimitive?.intOrNull,
                reasoningTokens = usageObj?.get("reasoning_tokens")?.jsonPrimitive?.intOrNull,
                toolCallsJson = toolCallsElement?.toString(),
                generatedArtifactsJson = artifactsElement?.toString(),
            )
        } catch (e: Exception) {
            logger.error(e) { "Failed to call retrieval server (non-streaming)" }
            RetrievalResult(null, null, null, null, null)
        }
    }

    /**
     * The user-facing message of a retrieval-server 422 for an unusable
     * attachment — `{"detail": {"error_type": "attachment_error", "message": ...}}`
     * — or null for any other error body.
     */
    internal fun attachmentErrorMessage(errorBody: String): String? = try {
        val detail = json.parseToJsonElement(errorBody).jsonObject["detail"]?.jsonObject
        detail?.takeIf { it["error_type"]?.jsonPrimitive?.content == "attachment_error" }
            ?.get("message")?.jsonPrimitive?.content
    } catch (e: Exception) {
        null
    }

    /**
     * Reads a /search 409 — `{"detail": {"error_type": ..., "message": ...}}`,
     * or the plain-string `detail` older retrieval-servers send, which only
     * ever reported a missing vector DB or embedding key.
     */
    private fun searchNotConfigured(errorBody: String): SearchNotConfiguredException {
        val detail = try {
            json.parseToJsonElement(errorBody).jsonObject["detail"]
        } catch (e: Exception) {
            null
        }
        val structured = detail as? kotlinx.serialization.json.JsonObject
        val message = structured?.get("message")?.jsonPrimitive?.content
            ?: (detail as? kotlinx.serialization.json.JsonPrimitive)?.content
            ?: "Search is not set up"
        val reason = when (structured?.get("error_type")?.jsonPrimitive?.content) {
            "embedding_key_missing" -> SearchSetupReason.EMBEDDING_KEY
            "vector_db_not_configured" -> SearchSetupReason.VECTOR_DB
            else -> if (message.contains("embedding provider")) SearchSetupReason.EMBEDDING_KEY else SearchSetupReason.VECTOR_DB
        }
        return SearchNotConfiguredException(reason, message)
    }

    /**
     * Executes a specific agent graph (request agents) through the LangGraph
     * runtime. Returns the final state's generated_response + usage; text is
     * null on any failure so callers can advance their provider failover.
     */
    suspend fun executeAgentGraph(
        graphId: String,
        customerId: String,
        variables: Map<String, String>,
        llmCredentials: Map<String, String>,
        llmProvider: String,
        llmModel: String,
        llmMaxTokens: Int = 4096,
        modelType: String? = null,
        modelName: String? = null,
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        requestSource: String = "internal",
        durable: Boolean = false
    ): RetrievalResult {
        logger.info { "Executing agent graph $graphId for customer $customerId (provider $llmProvider, model $llmModel, durable=$durable)" }
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/execute-agent-graph") {
                contentType(ContentType.Application.Json)
                setBody(json.encodeToString(ExecuteAgentGraphPayload(
                    graph_id = graphId,
                    customer_id = customerId,
                    variables = variables,
                    llm_credentials = llmCredentials,
                    llm_provider = llmProvider,
                    llm_model = llmModel,
                    llm_max_tokens = llmMaxTokens,
                    model_type = modelType,
                    model_name = modelName,
                    response_schema = responseSchema,
                    request_source = requestSource,
                    durable = durable
                )))
                timeout {
                    requestTimeoutMillis = 300_000L
                    socketTimeoutMillis = 300_000L
                }
            }
            val body = response.bodyAsText()
            if (!response.status.isSuccess()) {
                logger.error { "Agent graph execution error ${response.status}: $body" }
                return RetrievalResult(null, null, null, null, null)
            }
            val root = json.parseToJsonElement(body).jsonObject
            val usageObj = root["usage"]?.jsonObject
            RetrievalResult(
                text = root["generated_response"]?.jsonPrimitive?.content,
                inputTokens = usageObj?.get("input_tokens")?.jsonPrimitive?.intOrNull,
                outputTokens = usageObj?.get("output_tokens")?.jsonPrimitive?.intOrNull,
                totalTokens = usageObj?.get("total_tokens")?.jsonPrimitive?.intOrNull,
                tokensReadFromCache = usageObj?.get("cache_read_tokens")?.jsonPrimitive?.intOrNull,
                tokensWrittenToCache = usageObj?.get("cache_creation_tokens")?.jsonPrimitive?.intOrNull,
                reasoningTokens = usageObj?.get("reasoning_tokens")?.jsonPrimitive?.intOrNull,
            )
        } catch (e: Exception) {
            logger.error(e) { "Failed to execute agent graph $graphId" }
            RetrievalResult(null, null, null, null, null)
        }
    }

    fun retrieveAndGenerateStream(
        customerId: String,
        client: String,
        query: String,
        llmCredentials: Map<String, String>,
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
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        memoryEnabled: Boolean = false,
        requestSource: String = "conversation",
        graphId: String? = null,
        thinkingLevel: String? = null,
        memoryContext: MemoryContext? = null,
        entitlements: com.genflowly.models.CustomerEntitlements? = null,
        turnId: String? = null
    ): Flow<StreamChunk> = channelFlow {
        logger.info { "Calling retrieval-server (streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}, structured=${responseSchema != null}, graphId=$graphId" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, systemPrompt, stream = true, agentic = agentic, queryImages = queryImages, queryFiles = queryFiles, tools = tools, toolChoice = toolChoice, toolResults = toolResults, responseSchema = responseSchema, memoryEnabled = memoryEnabled, requestSource = requestSource, graphId = graphId, thinkingLevel = thinkingLevel, memoryContext = memoryContext, entitlements = entitlements, turnId = turnId)
        try {
            httpClient.preparePost("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payload)
                timeout {
                    // Bounds the WHOLE request including body streaming — with
                    // catalog-sized token budgets a long generation can far
                    // exceed 5 minutes, so only the socket timeout (time between
                    // chunks) guards against stalls.
                    requestTimeoutMillis = 1_800_000L
                    socketTimeoutMillis = 300_000L
                }
            }.execute { response ->
                if (!response.status.isSuccess()) {
                    val body = runCatching { response.bodyAsText() }.getOrNull()
                    logger.error { "Retrieval server error ${response.status}: $body" }
                    send(StreamChunk.Error(message = "Retrieval server returned ${response.status}", errorType = "retrieval_server_error"))
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
            // The read loop above only ever completes the flow normally or
            // throws here — without this chunk the caller sees a clean
            // end-of-stream indistinguishable from a real finish, and
            // silently persists whatever partial text had streamed in as if
            // it were the complete answer (see the Oct 2026 incident where a
            // retrieval-server OOM mid-stream produced a truncated "final"
            // message with no error shown to the user).
            logger.error(e) { "Streaming from retrieval server failed" }
            send(StreamChunk.Error(message = "Connection to the retrieval server was lost mid-response.", errorType = "transport_error"))
        }
    }.flowOn(Dispatchers.IO)

    /**
     * Fetches the model list per vendor via /models. Returns an empty map on
     * any transport error (callers treat missing vendors as "no models").
     */
    suspend fun listModels(
        apiKeys: Map<AIVendor, String>,
        capability: String = "all"
    ): Map<AIVendor, List<String>> {
        if (apiKeys.isEmpty()) return emptyMap()

        val start = System.currentTimeMillis()
        val payload = json.encodeToString(
            ListModelsPayload(
                vendors = apiKeys.map { (vendor, apiKey) ->
                    ListModelsVendorCredentials(
                        provider = vendor.toProviderString(),
                        api_key = apiKey,
                        capability = capability
                    )
                }
            )
        )

        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/models") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                val errorBody = response.bodyAsText()
                logger.warn { "Retrieval server /models returned ${response.status}: $errorBody" }
                return emptyMap()
            }

            val parsed = json.decodeFromString<ListModelsResponse>(response.bodyAsText())
            logger.info {
                "Models fetched via retrieval server: durationMs=${System.currentTimeMillis() - start}, " +
                    "counts=${parsed.vendor_models.associate { it.provider to it.models.size }}"
            }

            parsed.vendor_models.mapNotNull { vendorModels ->
                aiVendorFromProviderString(vendorModels.provider)?.let { it to vendorModels.models }
            }.toMap()
        } catch (e: Exception) {
            logger.warn { "Failed to fetch models from retrieval server: ${e.message}" }
            emptyMap()
        }
    }

    // BYOK vendor catalog — static per retrieval-server process, so one
    // successful fetch is cached for this process's lifetime too.
    @Volatile
    private var providerCatalogCache: com.genflowly.models.api.ProviderCatalogResponse? = null
    private var embeddingProviderCatalogCache: com.genflowly.models.api.EmbeddingProviderCatalogResponse? = null

    /**
     * Every provider the retrieval server can call (native tier + LiteLLM
     * long tail) with chat models and tool-support flags. Empty catalog on
     * transport failure (not cached, retried on next call).
     */
    suspend fun getProviderCatalog(): com.genflowly.models.api.ProviderCatalogResponse {
        providerCatalogCache?.let { return it }
        return try {
            val response: HttpResponse = httpClient.get("$retrievalServerUrl/providers")
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /providers returned ${response.status}" }
                return com.genflowly.models.api.ProviderCatalogResponse(providers = emptyList())
            }
            json.decodeFromString<com.genflowly.models.api.ProviderCatalogResponse>(response.bodyAsText())
                .also { providerCatalogCache = it }
        } catch (e: Exception) {
            logger.warn { "Failed to fetch provider catalog: ${e.message}" }
            com.genflowly.models.api.ProviderCatalogResponse(providers = emptyList())
        }
    }

    /**
     * Embedding-model pricing catalog from /embedding-providers — the
     * embedding-mode counterpart of [getProviderCatalog], used only to seed
     * AIModelCatalog pricing rows for Cost and Usage's Embedding Models page.
     */
    suspend fun getEmbeddingProviderCatalog(): com.genflowly.models.api.EmbeddingProviderCatalogResponse {
        embeddingProviderCatalogCache?.let { return it }
        return try {
            val response: HttpResponse = httpClient.get("$retrievalServerUrl/embedding-providers")
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /embedding-providers returned ${response.status}" }
                return com.genflowly.models.api.EmbeddingProviderCatalogResponse(providers = emptyList())
            }
            json.decodeFromString<com.genflowly.models.api.EmbeddingProviderCatalogResponse>(response.bodyAsText())
                .also { embeddingProviderCatalogCache = it }
        } catch (e: Exception) {
            logger.warn { "Failed to fetch embedding provider catalog: ${e.message}" }
            com.genflowly.models.api.EmbeddingProviderCatalogResponse(providers = emptyList())
        }
    }

    /**
     * [listModels] for providers outside the [AIVendor] enum (e.g. the
     * embedding-only "voyage"). Keys and results use retrieval-server
     * provider strings; transport failures degrade to an empty map.
     */
    suspend fun listModelsByProvider(
        apiKeysByProvider: Map<String, String>,
        capability: String = "all"
    ): Map<String, List<String>> {
        if (apiKeysByProvider.isEmpty()) return emptyMap()

        val payload = json.encodeToString(
            ListModelsPayload(
                vendors = apiKeysByProvider.map { (provider, apiKey) ->
                    ListModelsVendorCredentials(
                        provider = provider,
                        api_key = apiKey,
                        capability = capability
                    )
                }
            )
        )

        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/models") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            val body = response.bodyAsText()
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /models returned ${response.status}: $body" }
                return emptyMap()
            }
            json.decodeFromString<ListModelsResponse>(body)
                .vendor_models.associate { it.provider to it.models }
        } catch (e: Exception) {
            logger.warn { "Failed to fetch models from retrieval server: ${e.message}" }
            emptyMap()
        }
    }

    /**
     * Probes which of each vendor's catalog embedding models the given key can
     * actually embed, via /probe-embedding-models (one tiny embed per candidate
     * against the same vendor endpoint the encoder uses). Keys are
     * retrieval-server provider strings. Transport failure degrades to an empty
     * list — callers treat that as "no fresh data", never as "no models".
     */
    suspend fun probeEmbeddingModels(
        apiKeysByProvider: Map<String, String>
    ): List<VendorProbeResult> {
        if (apiKeysByProvider.isEmpty()) return emptyList()

        val payload = json.encodeToString(
            ProbeModelsPayload(
                vendors = apiKeysByProvider.map { (provider, apiKey) ->
                    ProbeVendorCredentials(provider = provider, api_key = apiKey)
                }
            )
        )

        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/probe-embedding-models") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            val body = response.bodyAsText()
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /probe-embedding-models returned ${response.status}: $body" }
                return emptyList()
            }
            json.decodeFromString<ProbeModelsResponse>(body).vendor_results.map {
                VendorProbeResult(
                    provider = it.provider,
                    supported = it.supported,
                    inconclusive = it.inconclusive,
                    error = it.error
                )
            }
        } catch (e: Exception) {
            logger.warn { "Failed to probe embedding models on retrieval server: ${e.message}" }
            emptyList()
        }
    }

    /**
     * Checks a vendor API key with one cheap authenticated vendor call via
     * /validate-key. Any transport error reads as invalid.
     */
    suspend fun validateApiKey(vendor: AIVendor, apiKey: String): Boolean =
        validateProviderKey(vendor.toProviderString(), apiKey)

    /**
     * [validateApiKey] for providers outside the [AIVendor] enum (e.g. the
     * embedding-only "voyage"). `provider` is the retrieval-server provider
     * string.
     */
    suspend fun validateProviderKey(provider: String, apiKey: String): Boolean =
        validateProviderKeyDetailed(provider, apiKey).valid

    /**
     * Like [validateProviderKey] but keeps the provider's rejection message —
     * "account suspended, recharge" and "key not valid" both fail the probe,
     * and the customer can only tell them apart from the actual error.
     */
    suspend fun validateProviderKeyDetailed(provider: String, apiKey: String): KeyValidationResult {
        val payload = json.encodeToString(
            ValidateKeyPayload(provider = provider, api_key = apiKey)
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/validate-key") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /validate-key returned ${response.status}" }
                return KeyValidationResult(valid = false, error = "Key validation service unavailable")
            }
            val parsed = json.decodeFromString<ValidateKeyResponse>(response.bodyAsText())
            if (!parsed.valid) {
                logger.info { "API key invalid for provider $provider: ${parsed.error}" }
            }
            KeyValidationResult(valid = parsed.valid, error = parsed.error)
        } catch (e: Exception) {
            logger.warn { "Failed to validate API key for provider $provider: ${e.message}" }
            KeyValidationResult(valid = false, error = "Key validation service unavailable")
        }
    }

    /**
     * Attaches the server-side control channel to a live WebRTC call
     * (/voice/calls/attach). The retrieval server opens and holds the
     * wss://api.openai.com/v1/realtime?call_id=... WebSocket.
     * Returns the raw status JSON ({"attached": bool, "error"?: string, ...}).
     */
    suspend fun attachVoiceCall(
        apiKey: String,
        callId: String,
        customerId: String,
        sessionUpdate: kotlinx.serialization.json.JsonObject?,
        webhookUrl: String?,
        webhookSecret: String?
    ): kotlinx.serialization.json.JsonObject = voiceCallPost(
        "/voice/calls/attach",
        json.encodeToString(
            AttachCallPayload(
                api_key = apiKey,
                call_id = callId,
                customer_id = customerId,
                session_update = sessionUpdate,
                webhook_url = webhookUrl,
                webhook_secret = webhookSecret,
            )
        )
    )

    /** Forwards raw Realtime client events over the call's control channel. */
    suspend fun sendVoiceCallEvents(
        callId: String,
        customerId: String,
        events: List<kotlinx.serialization.json.JsonObject>
    ): kotlinx.serialization.json.JsonObject = voiceCallPost(
        "/voice/calls/events",
        json.encodeToString(SendCallEventsPayload(call_id = callId, customer_id = customerId, events = events))
    )

    /** Live status + accumulated usage for an attached call. */
    suspend fun voiceCallStatus(callId: String, customerId: String): kotlinx.serialization.json.JsonObject =
        voiceCallPost("/voice/calls/status", json.encodeToString(CallRefPayload(callId, customerId)))

    /** Closes the control channel; returns the final usage summary. */
    suspend fun detachVoiceCall(callId: String, customerId: String): kotlinx.serialization.json.JsonObject =
        voiceCallPost("/voice/calls/detach", json.encodeToString(CallRefPayload(callId, customerId)))

    private suspend fun voiceCallPost(path: String, payload: String): kotlinx.serialization.json.JsonObject {
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl$path") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server $path returned ${response.status}" }
                return kotlinx.serialization.json.buildJsonObject {
                    put("error", kotlinx.serialization.json.JsonPrimitive("Call-control service unavailable"))
                }
            }
            json.parseToJsonElement(response.bodyAsText()).jsonObject
        } catch (e: Exception) {
            logger.warn { "Call-control request $path failed: ${e.message}" }
            kotlinx.serialization.json.buildJsonObject {
                put("error", kotlinx.serialization.json.JsonPrimitive("Call-control service unavailable"))
            }
        }
    }

    /**
     * Mints an OpenAI Realtime ephemeral client secret via
     * /voice/client-secret. The retrieval server is the only component that
     * talks to OpenAI; the long-lived vendor key never leaves the backend.
     */
    suspend fun createRealtimeClientSecret(
        apiKey: String,
        model: String,
        instructions: String,
        voice: String?,
        inputTranscriptionModel: String?
    ): RealtimeClientSecretResult {
        val payload = json.encodeToString(
            RealtimeClientSecretPayload(
                api_key = apiKey,
                model = model,
                instructions = instructions,
                voice = voice,
                input_transcription_model = inputTranscriptionModel,
            )
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/voice/client-secret") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /voice/client-secret returned ${response.status}" }
                return RealtimeClientSecretResult(error = "Client-secret service unavailable")
            }
            val parsed = json.decodeFromString<RealtimeClientSecretServerResponse>(response.bodyAsText())
            if (parsed.value == null) {
                logger.info { "Realtime client-secret mint failed: ${parsed.error}" }
            }
            RealtimeClientSecretResult(
                value = parsed.value,
                expiresAt = parsed.expires_at,
                error = parsed.error,
            )
        } catch (e: Exception) {
            logger.warn { "Failed to mint realtime client secret: ${e.message}" }
            RealtimeClientSecretResult(error = "Client-secret service unavailable")
        }
    }

    /**
     * Fetches per-model metadata (token limits, pricing) for the given
     * vendor/key pairs via /models/metadata. Returns one entry per vendor the
     * server answered for; a vendor-level fetch failure is reported via
     * [VendorModelMetadata.error] with an empty model list.
     */
    suspend fun fetchModelMetadata(vendorKeys: List<Pair<AIVendor, String>>): List<VendorModelMetadata> {
        if (vendorKeys.isEmpty()) return emptyList()

        val payload = json.encodeToString(
            ModelMetadataPayload(
                vendors = vendorKeys.map { (vendor, key) ->
                    MetadataVendorKey(provider = vendor.toProviderString(), api_key = key)
                }
            )
        )

        val response: HttpResponse = httpClient.post("$retrievalServerUrl/models/metadata") {
            contentType(ContentType.Application.Json)
            setBody(payload)
            timeout { requestTimeoutMillis = 120_000L }
        }
        if (!response.status.isSuccess()) {
            logger.error { "Retrieval server /models/metadata returned ${response.status}" }
            return emptyList()
        }

        val parsed = json.decodeFromString<ModelMetadataResponse>(response.bodyAsText())
        return parsed.vendor_models.mapNotNull { vendorMetadata ->
            val vendor = aiVendorFromProviderString(vendorMetadata.provider) ?: return@mapNotNull null
            VendorModelMetadata(
                vendor = vendor,
                models = vendorMetadata.models.map {
                    ModelCatalogEntry(
                        model = it.model,
                        maxOutputTokens = it.max_output_tokens,
                        maxInputTokens = it.max_input_tokens,
                        inputCostPerMTok = it.input_cost_per_mtok,
                        outputCostPerMTok = it.output_cost_per_mtok,
                        cacheReadCostPerMTok = it.cache_read_cost_per_mtok,
                        cacheWriteCostPerMTok = it.cache_write_cost_per_mtok,
                        inputAudioCostPerMTok = it.input_audio_cost_per_mtok,
                        outputAudioCostPerMTok = it.output_audio_cost_per_mtok,
                        cacheReadAudioCostPerMTok = it.cache_read_audio_cost_per_mtok
                    )
                },
                error = vendorMetadata.error,
                authFailed = vendorMetadata.auth_failed
            )
        }
    }

    /**
     * Hard-deletes a note's embeddings in the vector DB via /delete-note-vectors.
     * Throws on transport errors — callers decide whether that is fatal.
     */
    suspend fun deleteNoteVectors(customerId: String, noteKey: String): Boolean {
        val response = httpClient.post("$retrievalServerUrl/delete-note-vectors") {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(DeleteNoteVectorsPayload(customer_id = customerId, note_key = noteKey)))
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            logger.error { "Failed to delete vectors for note $noteKey: ${response.status} $errorBody" }
            return false
        }
        logger.info { "Successfully deleted vectors for note $noteKey" }
        return true
    }

    /**
     * Unified semantic search over the customer's vector collections via
     * /search — conversations, notes, memories, emails and future data types.
     * Returns chunk hits already grouped to one entry per source item (best
     * snippet + score). Pass [types] to restrict the searched data types;
     * null searches everything. [allowedKeys] maps a data type to the exact
     * group-key values the caller may see (e.g. "instructions" to accessible
     * instruction ids): that type is then matched by key instead of by the
     * customer's partition, so items indexed under OTHER customers (shared
     * instructions live under their creator) become findable — the id list IS
     * the access control, so it must come from an authoritative ACL check.
     * Never reports a failed search as an empty one: throws
     * [SearchNotConfiguredException] when the customer is missing a setting
     * search needs, [SearchUnavailableException] on any other error response,
     * and propagates transport errors.
     */
    suspend fun search(
        customerId: String,
        query: String,
        topN: Int,
        types: List<String>? = null,
        allowedKeys: Map<String, List<String>>? = null
    ): List<SearchVectorHit> {
        val response = httpClient.post("$retrievalServerUrl/search") {
            contentType(ContentType.Application.Json)
            setBody(
                json.encodeToString(
                    SearchPayload(
                        customer_id = customerId,
                        query = query,
                        top_n = topN,
                        types = types,
                        allowed_keys = allowedKeys
                    )
                )
            )
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            if (response.status == HttpStatusCode.Conflict) {
                logger.warn { "Search not configured for customer $customerId: $errorBody" }
                throw searchNotConfigured(errorBody)
            }
            logger.error { "Unified search failed for customer $customerId: ${response.status} $errorBody" }
            throw SearchUnavailableException(response.status.value, "Search failed: ${response.status}")
        }
        val wire = json.decodeFromString<SearchWireResponse>(response.bodyAsText())
        return wire.results.map {
            SearchVectorHit(
                type = it.type,
                key = it.key,
                title = it.title,
                score = it.score,
                snippet = it.snippet,
                matchedChunks = it.matched_chunks,
                createdAt = it.created_at
            )
        }
    }

    /**
     * Hard-deletes an instruction's embeddings in the vector DB via
     * /delete-instruction-vectors. Throws on transport errors — callers
     * decide whether that is fatal.
     */
    suspend fun deleteInstructionVectors(customerId: String, instructionId: String): Boolean {
        val response = httpClient.post("$retrievalServerUrl/delete-instruction-vectors") {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(DeleteInstructionVectorsPayload(customer_id = customerId, instruction_key = instructionId)))
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            logger.error { "Failed to delete vectors for instruction $instructionId: ${response.status} $errorBody" }
            return false
        }
        logger.info { "Successfully deleted vectors for instruction $instructionId" }
        return true
    }

    /**
     * Embeds one user memory and upserts it into the customer's memory vector
     * collection via the service-to-service /encode-memory (no end-user bearer
     * token — the retrieval server holds the embedding key and vector-store
     * connection). The route deletes the memory_key's prior vectors before
     * inserting, so re-encodes (UPDATE operations, extraction retries) replace
     * rather than duplicate. Throws on failure — callers decide severity.
     */
    suspend fun encodeMemoryVector(
        customerId: String,
        memoryKey: String,
        memoryValue: String,
        title: String,
        createdAt: String,
        modelType: String?,
        modelName: String?
    ) {
        val response = httpClient.post("$retrievalServerUrl/encode-memory") {
            contentType(ContentType.Application.Json)
            setBody(
                json.encodeToString(
                    EncodeMemoryPayload(
                        customer_id = customerId,
                        memory_key = memoryKey,
                        memory_value = memoryValue,
                        title = title,
                        created_at = createdAt,
                        model_type = modelType,
                        model_name = modelName,
                    )
                )
            )
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            throw VectorEncodeException(response.status.value, "encode-memory failed for $memoryKey: ${response.status} $errorBody")
        }
        logger.info { "Encoded memory $memoryKey into the vector store" }
    }

    /**
     * Embeds one user/assistant exchange into the customer's conversation
     * collection via the service-to-service /encode-conversation — the retry
     * path for exchanges whose encoding-server pipeline embed never landed
     * (that pipeline needs the end user's bearer token, which a later retry
     * doesn't have). Writes the same rows as the pipeline and deletes the
     * exchange's prior chunks first, so it is idempotent. Throws
     * [VectorEncodeException] on an error response.
     */
    suspend fun encodeConversationVector(
        customerId: String,
        conversationId: String,
        messageId: String,
        text: String,
        createdAt: String,
        client: String,
        modelType: String?,
        modelName: String?
    ) {
        val response = httpClient.post("$retrievalServerUrl/encode-conversation") {
            contentType(ContentType.Application.Json)
            setBody(
                json.encodeToString(
                    EncodeConversationPayload(
                        customer_id = customerId,
                        conversation_key = conversationId,
                        message_key = messageId,
                        text = text,
                        created_at = createdAt,
                        client = client,
                        model_type = modelType,
                        model_name = modelName,
                    )
                )
            )
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            throw VectorEncodeException(response.status.value, "encode-conversation failed for $messageId: ${response.status} $errorBody")
        }
        logger.info { "Encoded exchange $messageId into the vector store" }
    }

    /**
     * Hard-deletes a memory's embeddings in the vector DB via
     * /delete-memory-vectors. Throws on transport errors — callers decide
     * whether that is fatal.
     */
    suspend fun deleteMemoryVectors(customerId: String, memoryKey: String): Boolean {
        val response = httpClient.post("$retrievalServerUrl/delete-memory-vectors") {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(DeleteMemoryVectorsPayload(customer_id = customerId, memory_key = memoryKey)))
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            logger.error { "Failed to delete vectors for memory $memoryKey: ${response.status} $errorBody" }
            return false
        }
        logger.info { "Successfully deleted vectors for memory $memoryKey" }
        return true
    }

    /**
     * Hard-deletes every vector of one conversation in the customer's vector
     * DB via /delete-conversation-vectors. Throws when the retrieval server
     * could not finish, so the caller can retry.
     */
    suspend fun deleteConversationVectors(customerId: String, conversationId: String) {
        val response = httpClient.post("$retrievalServerUrl/delete-conversation-vectors") {
            contentType(ContentType.Application.Json)
            setBody(
                json.encodeToString(
                    DeleteConversationVectorsPayload(customer_id = customerId, conversation_key = conversationId)
                )
            )
        }
        check(response.status.isSuccess()) { "Conversation vector delete failed: ${response.status}" }
    }

    /**
     * Hard-deletes every vector the customer owns in their vector DB, for
     * account deletion: their rows in each shared collection and their legacy
     * per-customer collections. [dataType] narrows it to one type's
     * collections. Returns how many vectors were deleted. Throws when the
     * retrieval server could not finish, so the caller can retry.
     */
    suspend fun deleteCustomerVectors(customerId: String, dataType: String? = null): Int {
        val response = httpClient.post("$retrievalServerUrl/delete-customer-vectors") {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(DeleteCustomerVectorsPayload(customer_id = customerId, data_type = dataType)))
            // One delete per collection in the customer's cluster
            timeout {
                requestTimeoutMillis = 300_000L
                socketTimeoutMillis = 300_000L
            }
        }
        check(response.status.isSuccess()) { "Vector purge failed: ${response.status}" }
        return json.decodeFromString<DeleteCustomerVectorsResult>(response.bodyAsText()).deleted.values.sum()
    }
}

@Serializable
private data class DeleteNoteVectorsPayload(val customer_id: String, val note_key: String)

@Serializable
private data class DeleteCustomerVectorsPayload(
    val customer_id: String,
    /** Only this data type's collections (e.g. "conversation"); null = every type. */
    val data_type: String? = null
)

@Serializable
private data class DeleteConversationVectorsPayload(val customer_id: String, val conversation_key: String)

@Serializable
private data class DeleteCustomerVectorsResult(val deleted: Map<String, Int> = emptyMap())

@Serializable
private data class DeleteMemoryVectorsPayload(val customer_id: String, val memory_key: String)

@Serializable
private data class EncodeMemoryPayload(
    val customer_id: String,
    val memory_key: String,
    val memory_value: String,
    val title: String = "",
    val client: String = "memory",
    val created_at: String = "",
    val model_type: String? = null,
    val model_name: String? = null,
)

@Serializable
private data class EncodeConversationPayload(
    val customer_id: String,
    val conversation_key: String,
    val message_key: String,
    val text: String,
    val created_at: String = "",
    val client: String = "web",
    val model_type: String? = null,
    val model_name: String? = null,
)

@Serializable
private data class DeleteInstructionVectorsPayload(val customer_id: String, val instruction_key: String)

@Serializable
private data class SearchPayload(
    val customer_id: String,
    val query: String,
    val top_n: Int,
    val types: List<String>? = null,
    val allowed_keys: Map<String, List<String>>? = null
)

@Serializable
private data class SearchWireHit(
    val type: String,
    val key: String,
    val score: Double,
    val snippet: String = "",
    val title: String = "",
    val created_at: String = "",
    val client: String = "",
    val matched_chunks: Int = 1
)

@Serializable
private data class SearchWireResponse(val results: List<SearchWireHit> = emptyList())

/** The customer setting a search needs but doesn't have; [code] is what API clients see. */
enum class SearchSetupReason(val code: String) {
    VECTOR_DB("VECTOR_DB_NOT_CONFIGURED"),
    EMBEDDING_KEY("EMBEDDING_KEY_MISSING")
}

/** Search can't run until the customer configures [reason]; retrying won't help. */
class SearchNotConfiguredException(val reason: SearchSetupReason, message: String) : RuntimeException(message)

/**
 * The retrieval-server refused to embed a record with HTTP [status].
 * [permanent] failures (a missing customer setting, a malformed record) won't
 * succeed on retry.
 */
class VectorEncodeException(val status: Int, message: String) : IllegalStateException(message) {
    val permanent: Boolean get() = status == 409 || status == 400
}

/** The retrieval-server failed the search with HTTP [status]. */
class SearchUnavailableException(val status: Int, message: String) : RuntimeException(message)

/** An item-level semantic search hit (one per conversation/note/...), decoupled from the wire format. */
data class SearchVectorHit(
    val type: String,
    val key: String,
    val title: String,
    val score: Double,
    val snippet: String,
    val matchedChunks: Int,
    val createdAt: String
)
