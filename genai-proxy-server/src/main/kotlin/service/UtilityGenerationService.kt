package com.genflowly.service

import com.genflowly.aicallerlib.models.AIUsageMetadata
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeUsageMetadata
import com.genflowly.aicallerlib.models.gemini.GeminiUsageMetadata
import com.genflowly.aicallerlib.models.openai.OpenAIUsageMetadata
import models.AIGenerateResult
import models.Message
import org.slf4j.LoggerFactory

/**
 * One-shot utility generations over the direct vendor-SDK path (aicallerlib) —
 * conversation titles, instruction personas and similar internal calls. The
 * primary chat path goes through the retrieval-server instead (see
 * GenerationOrchestrator); keep real user traffic off this class.
 */
class UtilityGenerationService(
    private val aiRequestService: AIRequestService,
    private val customerCredentialsService: CustomerCredentialsService
) {
    private val logger = LoggerFactory.getLogger("UtilityGenerationService")

    suspend fun generateText(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): AIGenerateResult {
        try {
            // Step 1: Fetch API key for 3rd party AI vendor
            val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(aiVendor, customerId)
                ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

            return generateTextWithApiKey(aiVendor, model, messages, systemPrompt, apiKey)
        } catch (e: Exception) {
            val errorText = "Error occurred while generating response from $aiVendor - ${e.message}"
            return AIGenerateResult(text = errorText, inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null)
        }
    }

    /**
     * Generate text with an explicitly provided API key (e.g. a system key).
     * Unlike [generateText] this THROWS on any generation failure instead of
     * returning error text, so callers like the system-key failover can react.
     */
    suspend fun generateTextWithApiKey(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        apiKey: String
    ): AIGenerateResult {
        val startTime = System.currentTimeMillis()

        val aiResponse = when (aiVendor) {
            AIVendor.OPENAI -> {
                val params = aiRequestService.buildOpenAIRequest(
                    messages,
                    model,
                    systemPrompt ?: ""
                )
                val httpClient = aiRequestService.getOpenAIProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.openai.OpenAIRequest(
                        params
                    )
                )
            }

            AIVendor.GEMINI -> {
                val params = aiRequestService.buildGeminiRequest(
                    messages,
                    model,
                    systemPrompt ?: ""
                )
                val httpClient = aiRequestService.getGeminiProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.gemini.GeminiRequest(
                        params
                    )
                )
            }

            AIVendor.CLAUDE -> {
                val params = aiRequestService.buildClaudeRequest(
                    messages,
                    model,
                    systemPrompt ?: ""
                )
                val httpClient = aiRequestService.getClaudeProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.claude.ClaudeRequest(
                        params
                    )
                )
            }
        }

        val durationMs = System.currentTimeMillis() - startTime

        val responseText = aiResponse.getText() ?: ""
        val metadata = aiResponse.getUsageMetadata()
        val (inputTokens, outputTokens) = extractTokens(metadata)
        val totalTokens = metadata?.getTotalTokenCount()?.toInt()
        val tokensReadFromCache = metadata?.getTokenCountReadFromCache()?.toInt()

        logger.info(
            "AI response received: vendor={}, model={}, " +
                    "responseText={}, durationMs={}, inputTokens={}, outputTokens={}",
            aiVendor,
            model,
            responseText,
            durationMs,
            inputTokens,
            outputTokens
        )
        return AIGenerateResult(
            text = responseText,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            totalTokens = totalTokens,
            tokensReadFromCache = tokensReadFromCache
        )
    }

    /**
     * Normalises provider-specific [AIUsageMetadata] into a simple
     * (inputTokens, outputTokens) pair usable by the rest of the server.
     */
    private fun extractTokens(metadata: AIUsageMetadata?): Pair<Int?, Int?> {
        if (metadata == null) return Pair(null, null)
        return when (metadata) {
            is GeminiUsageMetadata -> Pair(metadata.promptTokens, metadata.completionTokens)
            is OpenAIUsageMetadata -> Pair(metadata.inputTokens, metadata.outputTokens)
            is ClaudeUsageMetadata -> Pair(
                metadata.inputTokens?.toInt(),
                metadata.outputTokens?.toInt()
            )
            else -> Pair(null, null)
        }
    }
}
