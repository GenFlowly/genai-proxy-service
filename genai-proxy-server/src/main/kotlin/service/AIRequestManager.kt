package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationService
import com.genflowly.utils.fetchApiKey
import models.AIConfig
import models.GenerateTextRequest
import models.GenerateTextResponse
import models.Message
import org.slf4j.LoggerFactory

class AIRequestManager(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService,
    private val conversationService: ConversationService
) {
    private val logger = LoggerFactory.getLogger("AIRequestManager")


    private suspend fun includeThreadContextInPrompt(
        conversationId: String,
        messageId: String,
        prompt: String
    ): String {
        val messages = conversationService.getMessageThread(conversationId, messageId)

        if (messages.isEmpty()) return prompt.trim()

        return buildString {
            messages.forEach { msg ->
                appendLine("${msg.role}: ${msg.text.trim()}")
            }
            append("user: ${prompt.trim()}")
        }.trimEnd()
    }


    suspend fun getConversationId(
        request: GenerateTextRequest
    ): String {
        val activeConversationId = if (request.conversationId.isNullOrBlank()) {
            conversationService.createConversation(
                request.customerId,
                request.client
            )
        } else {
            request.conversationId
        }
        return activeConversationId
    }

    /**
     * Handles a single AI text generation request.
     */
    suspend fun handleRequest(
        aiVendor: AIVendor,
        model: String,
        message: Message
    ): GenerateTextResponse {
        val startTime = System.currentTimeMillis()

        val apiKey = fetchApiKey(
            aiVendor,
            message.customerId,
            customerProfileService
        )

        val promptMessageId = conversationService.addMessageInConversation(message)

        val promptWithContext = includeThreadContextInPrompt(
            message.conversationId,
            promptMessageId,
            message.text
        )


        logger.info("Sending prompt = {}", promptWithContext)

        val aiResponse = when (aiVendor) {
            AIVendor.OPENAI -> {
                val params = aiRequestService.buildOpenAIRequest(
                    promptWithContext,
                    model
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
                    promptWithContext,
                    model
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
                    promptWithContext,
                    model
                )
                val httpClient = aiRequestService.getClaudeProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.claude.ClaudeRequest(
                        params
                    )
                )
            }
        }

        var responseMessageId = ""
        try {
            val responseText = aiResponse.getText()
            logger.info("Received response = {}", responseText)
            if (!responseText.isNullOrBlank()) {
                val responseMessage = Message(
                    conversationId = message.conversationId,
                    customerId = message.customerId,
                    client = message.client,
                    role = "assistant",
                    text = responseText,
                    previousMessageId = message.previousMessageId,
                    aiConfig = AIConfig(aiVendor = aiVendor, model = model)
                )
                responseMessageId = conversationService.addMessageInConversation(responseMessage)
            } else {
                logger.warn("AI response text is null or blank for conversationId=$message.conversationId")
            }
        } catch (e: Exception) {
            logger.error(
                "Failed to add assistant message to conversationId=$message.conversationId",
                e
            )
        }

        val durationMs = System.currentTimeMillis() - startTime
        logger.info(
            "AI response received: vendor={}, model={}, durationMs={}",
            aiVendor,
            model,
            durationMs
        )

        return GenerateTextResponse(
            text = aiResponse.getText(),
            conversationId = message.conversationId,
            messageId = responseMessageId,
            aiVendor = aiVendor.name
        )
    }
}
