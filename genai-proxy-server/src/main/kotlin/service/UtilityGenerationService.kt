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
    private val customerCredentialsService: CustomerCredentialsService,
    private val modelCatalogService: ModelCatalogService
) {
    private val logger = LoggerFactory.getLogger("UtilityGenerationService")

    /**
     * Generates with the customer's stored vendor key. Failures return an
     * empty-text result (never an error message as text), so callers can treat
     * blank output as "no result".
     */
    suspend fun generateText(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): AIGenerateResult {
        return try {
            val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(aiVendor, customerId)
                ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

            generateTextWithApiKey(aiVendor, model, messages, systemPrompt, apiKey)
        } catch (e: Exception) {
            logger.warn("Utility generation failed for vendor {}: {}", aiVendor, e.message)
            AIGenerateResult(text = "", inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null)
        }
    }

    /**
     * Generate text with an explicitly provided API key (e.g. a system key).
     * Unlike [generateText] this THROWS on any generation failure instead of
     * returning empty text, so callers like the system-key failover can react.
     */
    suspend fun generateTextWithApiKey(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        apiKey: String
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
                vendor = aiVendor, model = model, requested = null, streaming = false
            ),
            conversationHistory = history,
            systemPrompt = systemPrompt,
            agentic = false
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
