package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationService
import com.genflowly.utils.fetchApiKey
import models.GenerateTextRequest
import models.GenerateTextResponse
import org.slf4j.LoggerFactory

class AIRequestManager(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService,
    private val conversationService: ConversationService
) {
    private val logger = LoggerFactory.getLogger("AIRequestManager")


    suspend fun getConversationId(
        request: GenerateTextRequest
    ): String {
        val activeConversationId = if (request.conversationId.isNullOrBlank()) {
            conversationService.createConversation(request.customerId,
                request.client)
        } else {
            request.conversationId
        }
        return activeConversationId
    }

    /**
     * Handles a single AI text generation request.
     */
    suspend fun handleRequest(
        vendor: AIVendor,
        model: String,
        prompt: String,
        customerId: String,
        conversationId: String,
        selectedResponseId: String?,
        client: String
    ): GenerateTextResponse {
        val startTime = System.currentTimeMillis()

        val apiKey = fetchApiKey(
            vendor,
            customerId,
            customerProfileService
        )

        conversationService.addMessageInConversation(
            conversationId = conversationId,
            customerId = customerId,
            role = "user",
            client = client, 
            vendor = vendor,
            text = prompt,
            previousMessageId = selectedResponseId
        )

        val aiResponse = when (vendor) {
            AIVendor.OPENAI -> {
                val params = aiRequestService.buildOpenAIRequest(prompt, model)
                val httpClient = aiRequestService.getOpenAIProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.openai.OpenAIRequest(
                        params
                    )
                )
            }

            AIVendor.GEMINI -> {
                val params = aiRequestService.buildGeminiRequest(prompt, model)
                val httpClient = aiRequestService.getGeminiProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.gemini.GeminiRequest(
                        params
                    )
                )
            }

            AIVendor.CLAUDE -> {
                val params = aiRequestService.buildClaudeRequest(prompt, model)
                val httpClient = aiRequestService.getClaudeProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.claude.ClaudeRequest(
                        params
                    )
                )
            }
        }
        var messageId = ""
        try {
            val responseText = aiResponse.getText()
            if (!responseText.isNullOrBlank()) {
                messageId = conversationService.addMessageInConversation(
                    conversationId,
                    customerId,
                    "assistant",
                    client,
                    vendor,
                    responseText,
                    previousMessageId = selectedResponseId
                )
            } else {
                logger.warn("AI response text is null or blank for conversationId=$conversationId")
            }
        } catch (e: Exception) {
            logger.error(
                "Failed to add assistant message to conversationId=$conversationId",
                e
            )
        }


        val durationMs = System.currentTimeMillis() - startTime
        logger.info(
            "AI response received: vendor={}, model={}, durationMs={}",
            vendor,
            model,
            durationMs
        )

        return GenerateTextResponse(
            text = aiResponse.getText(),
            conversationId = conversationId,
            messageId = messageId,
            aiVendor = vendor.name
        )
    }
}
