package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.Message
import com.genflowly.models.retrieval.toConversationMessage
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import com.genflowly.providers.RetrievalServerClient
import org.slf4j.LoggerFactory

/**
 * One-shot utility generations (conversation titles, instruction personas and
 * similar internal calls), routed through the retrieval-server like all other
 * generation traffic. Runs with agentic=false, so the server executes a single
 * direct-LLM node instead of the customer's agent graph.
 */
class UtilityGenerationService(
    private val retrievalServerClient: RetrievalServerClient,
    private val modelCatalogService: ModelCatalogService
) {
    private val logger = LoggerFactory.getLogger("UtilityGenerationService")

    /**
     * Generate text with an explicitly provided API key. THROWS on any
     * generation failure instead of returning empty text, so failover
     * callers can react.
     */
    suspend fun generateTextWithApiKey(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        apiKey: String,
        maxTokens: Int? = null,
        /** JSON Schema for vendor-enforced structured output (guaranteed-JSON text) */
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        /** Purpose label for llm_request_total{source=...}: the RequestType lowercased. */
        requestSource: String = "internal"
    ): AIGenerateResult {
        val lastMessage = messages.lastOrNull()
            ?: throw IllegalArgumentException("No message to generate from")
        val history = messages.dropLast(1).map { it.toConversationMessage() }

        val result = retrievalServerClient.retrieveAndGenerate(
            customerId = lastMessage.customerId,
            client = "internal",
            query = lastMessage.text,
            llmCredentials = mapOf(aiVendor.toCredentialKey() to apiKey),
            llmProvider = aiVendor.toProviderString(),
            llmModel = model,
            llmMaxTokens = modelCatalogService.resolveMaxTokens(
                vendor = aiVendor, model = model, requested = maxTokens, streaming = false
            ),
            conversationHistory = history,
            systemPrompt = systemPrompt,
            agentic = false,
            responseSchema = responseSchema,
            requestSource = requestSource
        )

        val text = result.text
            ?: throw IllegalStateException("No response from retrieval server for ${aiVendor.name}/$model")

        return AIGenerateResult(
            text = text,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            totalTokens = result.totalTokens,
            tokensReadFromCache = result.tokensReadFromCache
        )
    }
}
