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
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.VendorModelMetadata
import com.genflowly.models.aiVendorFromProviderString
import com.genflowly.models.toProviderString
import mu.KLogger

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
    val tool_results: List<PayloadToolResult> = emptyList()
)

@Serializable
private data class AgentRawData(
    val query_data: String,
    val top_n: Int = 3,
    /** Images attached to the current-turn query */
    val images: List<ImageRef> = emptyList()
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

@Serializable
private data class ValidateKeyPayload(val provider: String, val api_key: String)

@Serializable
private data class ValidateKeyResponse(
    val provider: String,
    val valid: Boolean,
    val error: String? = null
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
    val cache_write_cost_per_mtok: Double? = null
)

@Serializable
private data class WireVendorModelMetadata(
    val provider: String,
    val models: List<ModelMetadataEntry>,
    val error: String? = null
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
        tools: List<PayloadToolDefinition>,
        toolChoice: String?,
        toolResults: List<PayloadToolResult>
    ): String = json.encodeToString(
        RetrievalAgentPayload(
            customer_id = customerId,
            client = client,
            data_type = "text",
            raw_data = AgentRawData(query_data = query, images = queryImages),
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
            tool_results = toolResults
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
        tools: List<PayloadToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<PayloadToolResult> = emptyList()
    ): RetrievalResult {
        logger.info { "Calling retrieval-server (non-streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, systemPrompt, stream = false, agentic = agentic, queryImages = queryImages, tools = tools, toolChoice = toolChoice, toolResults = toolResults)
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
                return RetrievalResult(null, null, null, null, null)
            }
            val body = response.bodyAsText()
            val root = json.parseToJsonElement(body).jsonObject
            val text = root["generated_response"]?.jsonPrimitive?.content
            val usageObj = root["usage"]?.jsonObject
            val toolCallsElement = root["tool_calls"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
            RetrievalResult(
                text = text,
                inputTokens = usageObj?.get("input_tokens")?.jsonPrimitive?.intOrNull,
                outputTokens = usageObj?.get("output_tokens")?.jsonPrimitive?.intOrNull,
                totalTokens = usageObj?.get("total_tokens")?.jsonPrimitive?.intOrNull,
                tokensReadFromCache = usageObj?.get("cache_read_tokens")?.jsonPrimitive?.intOrNull,
                toolCallsJson = toolCallsElement?.toString(),
            )
        } catch (e: Exception) {
            logger.error(e) { "Failed to call retrieval server (non-streaming)" }
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
        tools: List<PayloadToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<PayloadToolResult> = emptyList()
    ): Flow<StreamChunk> = channelFlow {
        logger.info { "Calling retrieval-server (streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, systemPrompt, stream = true, agentic = agentic, queryImages = queryImages, tools = tools, toolChoice = toolChoice, toolResults = toolResults)
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
                    logger.error { "Retrieval server error ${response.status}" }
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
                        when {
                            jsonObj.containsKey("content") -> {
                                val content = jsonObj["content"]?.jsonPrimitive?.content
                                if (!content.isNullOrEmpty()) send(StreamChunk.Content(content))
                            }
                            jsonObj.containsKey("thinking") -> {
                                val thinking = jsonObj["thinking"]?.jsonPrimitive?.content
                                if (!thinking.isNullOrEmpty()) send(StreamChunk.Thinking(thinking))
                            }
                            jsonObj.containsKey("thinking_duration_ms") -> {
                                val millis = jsonObj["thinking_duration_ms"]?.jsonPrimitive?.content?.toLongOrNull()
                                if (millis != null) send(StreamChunk.ThinkingDuration(millis))
                            }
                            jsonObj.containsKey("tool_calls") -> {
                                val toolCalls = jsonObj["tool_calls"]
                                if (toolCalls != null && toolCalls !is kotlinx.serialization.json.JsonNull) {
                                    send(StreamChunk.ToolCalls(toolCalls.toString()))
                                }
                            }
                            jsonObj.containsKey("usage") -> {
                                val usageObj = jsonObj["usage"]!!.jsonObject
                                send(
                                    StreamChunk.Usage(
                                        inputTokens = usageObj["input_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                        outputTokens = usageObj["output_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                        totalTokens = usageObj["total_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                        tokensReadFromCache = usageObj["cache_read_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                    )
                                )
                            }
                        }
                    } catch (_: Exception) {
                        // skip malformed SSE chunk
                    }
                }
            }
        } catch (e: Exception) {
            logger.error(e) { "Streaming from retrieval server failed" }
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

    /**
     * Checks a vendor API key with one cheap authenticated vendor call via
     * /validate-key. Any transport error reads as invalid.
     */
    suspend fun validateApiKey(vendor: AIVendor, apiKey: String): Boolean {
        val payload = json.encodeToString(
            ValidateKeyPayload(provider = vendor.toProviderString(), api_key = apiKey)
        )
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/validate-key") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                logger.warn { "Retrieval server /validate-key returned ${response.status}" }
                return false
            }
            val parsed = json.decodeFromString<ValidateKeyResponse>(response.bodyAsText())
            if (!parsed.valid) {
                logger.info { "API key invalid for vendor $vendor: ${parsed.error}" }
            }
            parsed.valid
        } catch (e: Exception) {
            logger.warn { "Failed to validate API key for vendor $vendor: ${e.message}" }
            false
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
                        cacheWriteCostPerMTok = it.cache_write_cost_per_mtok
                    )
                },
                error = vendorMetadata.error
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
     * Semantic search over the customer's conversation collections via
     * /search-conversations. Returns chunk hits already grouped to one entry
     * per conversation (best snippet + score). Throws on transport errors —
     * callers decide whether that is fatal.
     */
    suspend fun searchConversations(customerId: String, query: String, topN: Int): List<ConversationVectorHit> {
        val response = httpClient.post("$retrievalServerUrl/search-conversations") {
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(SearchConversationsPayload(customer_id = customerId, query = query, top_n = topN)))
        }
        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            logger.error { "Conversation search failed for customer $customerId: ${response.status} $errorBody" }
            return emptyList()
        }
        val wire = json.decodeFromString<SearchConversationsWireResponse>(response.bodyAsText())
        return wire.conversations.map {
            ConversationVectorHit(
                conversationId = it.conversation_key,
                score = it.score,
                snippet = it.snippet,
                matchedChunks = it.matched_chunks,
                createdAt = it.created_at
            )
        }
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
}

@Serializable
private data class DeleteNoteVectorsPayload(val customer_id: String, val note_key: String)

@Serializable
private data class DeleteMemoryVectorsPayload(val customer_id: String, val memory_key: String)

@Serializable
private data class SearchConversationsPayload(val customer_id: String, val query: String, val top_n: Int)

@Serializable
private data class SearchConversationsWireHit(
    val conversation_key: String,
    val score: Double,
    val snippet: String = "",
    val message_key: String = "",
    val created_at: String = "",
    val client: String = "",
    val matched_chunks: Int = 1
)

@Serializable
private data class SearchConversationsWireResponse(val conversations: List<SearchConversationsWireHit> = emptyList())

/** A conversation-level semantic search hit, decoupled from the wire format. */
data class ConversationVectorHit(
    val conversationId: String,
    val score: Double,
    val snippet: String,
    val matchedChunks: Int,
    val createdAt: String
)
