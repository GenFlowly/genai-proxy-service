package service

import com.genflowly.aicallerlib.models.AIResponse
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.utils.fetchApiKey
import org.slf4j.LoggerFactory

class AIRequestManager(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService
) {
    private val logger = LoggerFactory.getLogger("AIRequestManager")

    /**
     * Handles a single AI text generation request.
     */
    suspend fun handleRequest(
        vendor: AIVendor,
        model: String,
        prompt: String,
        customerId: String
    ): AIResponse {
        val startTime = System.currentTimeMillis()

        val apiKey = fetchApiKey(
            vendor,
            customerId,
            customerProfileService
        )

        val aiResponse = when (vendor) {
            AIVendor.OPENAI -> {
                val params = aiRequestService.buildOpenAIRequest(prompt, model)
                val client = aiRequestService.getOpenAIProvider(apiKey)
                client.generateResponse(com.genflowly.aicallerlib.models.openai.OpenAIRequest(params))
            }

            AIVendor.GEMINI -> {
                val params = aiRequestService.buildGeminiRequest(prompt, model)
                val client = aiRequestService.getGeminiProvider(apiKey)
                client.generateResponse(com.genflowly.aicallerlib.models.gemini.GeminiRequest(params))
            }

            AIVendor.CLAUDE -> {
                val params = aiRequestService.buildClaudeRequest(prompt, model)
                val client = aiRequestService.getClaudeProvider(apiKey)
                client.generateResponse(com.genflowly.aicallerlib.models.claude.ClaudeRequest(params))
            }
        }

        val durationMs = System.currentTimeMillis() - startTime
        logger.info("AI response received: vendor={}, model={}, durationMs={}", vendor, model, durationMs)

        return aiResponse
    }

    /**
     * Convenience wrapper for handling a GenerateTextRequest.
     */
    suspend fun handleGenerateTextRequest(request: models.GenerateTextRequest): models.GenerateTextResponse {
        val apiKey = fetchApiKey(request.vendor, request.customerId, customerProfileService)
        val aiResponse = handleRequest(request.vendor, request.model, request.prompt, request.customerId)
        return models.GenerateTextResponse(text = aiResponse.getText())
    }
}
