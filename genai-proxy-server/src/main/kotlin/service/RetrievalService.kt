package com.genflowly.service

import io.ktor.client.*
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
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
import mu.KLogger

sealed class StreamChunk {
    data class Content(val text: String) : StreamChunk()
    data class Thinking(val text: String) : StreamChunk()
    /** Request receipt on the retrieval server → first generated token, in ms */
    data class ThinkingDuration(val millis: Long) : StreamChunk()
    /** Raw JSON array of tool calls the model made: [{"id","name","args"}] */
    data class ToolCalls(val json: String) : StreamChunk()
    data class Usage(
        val inputTokens: Int,
        val outputTokens: Int,
        val totalTokens: Int,
        val tokensReadFromCache: Int
    ) : StreamChunk()
}

data class RetrievalResult(
    val text: String?,
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?,
    val tokensReadFromCache: Int?,
    /** JSON array of tool calls the model made, null when it answered directly */
    val toolCallsJson: String? = null
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

class RetrievalService(
    private val logger: KLogger,
    private val json: Json,
    private val httpClient: HttpClient
) {
    private val retrievalServerUrl: String = System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001"

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
        logger.info { "Calling retrieval-server (non-streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}, systemPrompt=$systemPrompt" }
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
        logger.info { "Calling retrieval-server (streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}, agentic=$agentic, images=${queryImages.size}, tools=${tools.size}, toolResults=${toolResults.size}, hasSystemPrompt=${!systemPrompt.isNullOrBlank()}, systemPrompt=$systemPrompt" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, systemPrompt, stream = true, agentic = agentic, queryImages = queryImages, tools = tools, toolChoice = toolChoice, toolResults = toolResults)
        try {
            httpClient.preparePost("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payload)
                timeout {
                    requestTimeoutMillis = 300_000L
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
}
