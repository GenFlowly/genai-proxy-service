package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationService
import com.genflowly.utils.fetchApiKey
import io.ktor.server.response.respond
import models.AIConfig
import models.GenerateTextRequest
import models.GenerateTextResponse
import models.Message
import org.slf4j.LoggerFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import models.BatchGenerateTextResponse

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
        val messages =
            conversationService.getMessageThread(conversationId, messageId)

        if (messages.isEmpty()) return prompt.trim()

        return buildString {
            messages.forEach { msg ->
                appendLine("${msg.role}: ${msg.text.trim()}")
            }
        }.trimEnd()
    }


    suspend fun getConversationId(
        request: GenerateTextRequest,
        customerId: String,
        client: String
    ): String {
        val activeConversationId = if (request.conversationId.isNullOrBlank()) {
            conversationService.createConversation(
                customerId,
                client
            )
        } else {
            request.conversationId
        }
        return activeConversationId
    }

    suspend fun getConversationId(
        customerId: String,
        client: String,
        conversationId: String? = null
    ): String {
        val activeConversationId = if (conversationId.isNullOrBlank()) {
            conversationService.createConversation(
                customerId,
                client
            )
        } else {
            conversationId
        }
        return activeConversationId
    }

    suspend fun processTextGenerateRequest(
        aiConfig: List<AIConfig>,
        systemPrompt: String,
        prompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String

    ): List<Message> {


        // Step 1 - Fetch existing or Create new conversation
        val conversationId =
            getConversationId(customerId, client, conversationId)

        // Step 2 - Create message object
        val message = Message(
            conversationId = conversationId,
            customerId = customerId,
            client = client,
            role = "user",
            text = prompt,
            previousMessageId = selectedResponseId,
            aiConfig = aiConfig,
            systemPrompt = systemPrompt
        )

        // Step 3 - Add message request to conversation
        conversationService.addMessageInConversation(message)

        logger.info("Added Message id {} to conversation", message.messageId)

        // Step 4 - Handle request for each AI vendor in loop
        val responseMessageList = coroutineScope {
            message.aiConfig.map { aiConfig ->
                async {
                    fetchResponseFromAIVendor(
                        aiVendor = aiConfig.aiVendor,
                        model = aiConfig.model,
                        message = message
                    )
                }
            }.awaitAll()
        }

        // Step 5 - Return message response list
        return responseMessageList
    }


    suspend fun fetchResponseFromAIVendor(
        aiVendor: AIVendor,
        model: String,
        message: Message
    ): Message {
        // Step 1: Start timer for 3rd party API call
        val startTime = System.currentTimeMillis()

        // Step 2: Fetch API key for 3rd party AI vendor
        val apiKey = fetchApiKey(
            aiVendor,
            message.customerId,
            customerProfileService
        )

        // Step 3: Build conversation history for prompt
        val promptWithContext = includeThreadContextInPrompt(
            message.conversationId,
            message.messageId,
            message.text
        )


        logger.info("Sending prompt with context = {}", promptWithContext)

        // Step 4: Call respective 3rd party AI vendor API
        val aiResponse = when (aiVendor) {
            AIVendor.OPENAI -> {
                val params = aiRequestService.buildOpenAIRequest(
                    promptWithContext,
                    model,
                    message.systemPrompt
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
                    model,
                    message.systemPrompt
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
                    model,
                    message.systemPrompt
                )
                val httpClient = aiRequestService.getClaudeProvider(apiKey)
                httpClient.generateResponse(
                    com.genflowly.aicallerlib.models.claude.ClaudeRequest(
                        params
                    )
                )
            }
        }

        // Step 5: Stop timer for 3rd party API call
        val durationMs = System.currentTimeMillis() - startTime

        // Step 6: Null check response and throw exception if null
        val responseText = aiResponse.getText()

        require(!responseText.isNullOrBlank()) {
            "AI response text is null or blank for conversationId=${message.conversationId}"
        }


        // Step 7: Create response message object
        val responseMessage = Message(
            conversationId = message.conversationId,
            customerId = message.customerId,
            client = message.client,
            role = "assistant",
            text = responseText,
            previousMessageId = message.messageId,
            aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
            systemPrompt = message.systemPrompt
        )

        // Step 8: Add response message to conversation
        conversationService.addMessageInConversation(responseMessage)


        logger.info(
            "AI response received: vendor={}, model={}, durationMs={}",
            aiVendor,
            model,
            durationMs
        )

        // Step 5 - Return response message from the respective AI vendor
        return responseMessage
    }
}
