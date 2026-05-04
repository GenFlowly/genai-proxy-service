package com.genflowly.service

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.HttpTimeout
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
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KLogger

sealed class StreamChunk {
    data class Content(val text: String) : StreamChunk()
    data class Thinking(val text: String) : StreamChunk()
    data class Usage(val inputTokens: Int, val outputTokens: Int, val totalTokens: Int) : StreamChunk()
}

data class RetrievalResult(
    val text: String?,
    val inputTokens: Int?,
    val outputTokens: Int?,
    val totalTokens: Int?
)

@Serializable
data class ConversationMessage(
    val role: String,
    val content: String
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
    val stream: Boolean = false
)

@Serializable
private data class AgentRawData(
    val query_data: String,
    val top_n: Int = 3
)

class RetrievalService(
    private val logger: KLogger,
    private val json: Json
) {
    private val retrievalServerUrl: String = System.getenv("RETRIEVAL_SERVER_URL") ?: "http://retrieval-server:5001"

    private val httpClient = HttpClient(CIO) {
        install(HttpTimeout) {
            requestTimeoutMillis = 300_000L
            connectTimeoutMillis = 30_000L
            socketTimeoutMillis = 300_000L
        }
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
        stream: Boolean
    ): String = json.encodeToString(
        RetrievalAgentPayload(
            customer_id = customerId,
            client = client,
            data_type = "text",
            raw_data = AgentRawData(query_data = query),
            llm_credentials = llmCredentials,
            llm_provider = llmProvider,
            llm_model = llmModel,
            llm_max_tokens = llmMaxTokens,
            conversation_history = conversationHistory,
            stream = stream
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
        conversationHistory: List<ConversationMessage> = emptyList()
    ): RetrievalResult {
        logger.info { "Calling retrieval-server (non-streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, stream = false)
        return try {
            val response: HttpResponse = httpClient.post("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payload)
            }
            if (!response.status.isSuccess()) {
                val errorBody = response.bodyAsText()
                logger.error { "Retrieval server error ${response.status}: $errorBody" }
                return RetrievalResult(null, null, null, null)
            }
            val body = response.bodyAsText()
            val root = json.parseToJsonElement(body).jsonObject
            val text = root["generated_response"]?.jsonPrimitive?.content
            val usageObj = root["usage"]?.jsonObject
            RetrievalResult(
                text = text,
                inputTokens = usageObj?.get("input_tokens")?.jsonPrimitive?.intOrNull,
                outputTokens = usageObj?.get("output_tokens")?.jsonPrimitive?.intOrNull,
                totalTokens = usageObj?.get("total_tokens")?.jsonPrimitive?.intOrNull,
            )
        } catch (e: Exception) {
            logger.error(e) { "Failed to call retrieval server (non-streaming)" }
            RetrievalResult(null, null, null, null)
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
        conversationHistory: List<ConversationMessage> = emptyList()
    ): Flow<StreamChunk> = channelFlow {
        logger.info { "Calling retrieval-server (streaming) for customer $customerId, provider $llmProvider, model $llmModel, maxTokens $llmMaxTokens, history=${conversationHistory.size}" }
        val payload = buildPayload(customerId, client, query, llmCredentials, llmProvider, llmModel, llmMaxTokens, conversationHistory, stream = true)
        try {
            httpClient.preparePost("$retrievalServerUrl/retrieve") {
                contentType(ContentType.Application.Json)
                setBody(payload)
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
                            jsonObj.containsKey("usage") -> {
                                val usageObj = jsonObj["usage"]!!.jsonObject
                                send(
                                    StreamChunk.Usage(
                                        inputTokens = usageObj["input_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                        outputTokens = usageObj["output_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
                                        totalTokens = usageObj["total_tokens"]?.jsonPrimitive?.intOrNull ?: 0,
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
