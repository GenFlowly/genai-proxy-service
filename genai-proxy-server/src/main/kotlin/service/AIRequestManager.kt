package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
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

        var responseText: String?

        // Step 1: Build conversation history for prompt
        val promptWithContext = includeThreadContextInPrompt(
            message.conversationId,
            message.messageId,
            message.text
        )


        logger.info("Sending prompt with context = {}", promptWithContext)
        
        responseText = generateText(
            aiVendor, 
            model, 
            promptWithContext, 
            message.systemPrompt, 
            message.customerId
        )

        val responseMessage: Message
        if (!responseText.isNullOrBlank()) {

            // Step 7: Create response message object
            responseMessage = Message(
                conversationId = message.conversationId,
                customerId = message.customerId,
                client = message.client,
                role = "assistant",
                text = responseText,
                previousMessageId = message.messageId,
                aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
                systemPrompt = message.systemPrompt
            )
        } else {
            responseMessage = Message(
                conversationId = message.conversationId,
                customerId = message.customerId,
                client = message.client,
                role = "assistant",
                text = "No response received. Please try again.",
                previousMessageId = message.messageId,
                aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
                systemPrompt = message.systemPrompt
            )
        }


        // Step 8: Add response message to conversation
        conversationService.addMessageInConversation(responseMessage)



        // Step 5 - Return response message from the respective AI vendor
        return responseMessage
    }
    
    suspend fun generateText(
        aiVendor: AIVendor,
        model: String,
        prompt: String,
        systemPrompt: String?,
        customerId: String
    ): String {
        try {
            // Step 1: Fetch API key for 3rd party AI vendor
            val apiKey = fetchApiKey(
                aiVendor,
                customerId,
                customerProfileService
            )

            // Step 2: Start timer for 3rd party API call
            val startTime = System.currentTimeMillis()

            val aiResponse = when (aiVendor) {
                AIVendor.OPENAI -> {
                    val params = aiRequestService.buildOpenAIRequest(
                        prompt,
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
                        prompt,
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
                        prompt,
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


            // Step 3: Stop timer for 3rd party API call
            val durationMs = System.currentTimeMillis() - startTime

            // Step 4: Null check response and throw exception if null
            val responseText = aiResponse.getText() ?: ""

            logger.info(
                "AI response received: vendor={}, model={}, " +
                        "responseText={}, durationMs={}",
                aiVendor,
                model,
                responseText,
                durationMs
            )
            return responseText

        } catch (e: Exception) {
            return "Error occurred while generating response from " +
                    "$aiVendor - ${e.message}"
        }
    }

    suspend fun processTextGenerateStreamRequest(
        aiConfig: List<AIConfig>,
        systemPrompt: String,
        prompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String
    ): kotlinx.coroutines.flow.Flow<String> = kotlinx.coroutines.flow.flow {

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            getConversationId(customerId, client, conversationId)

        // Step 2 - Create message object
        // Step 2 - Create message object
        // Use Deterministic ID to prevent duplication in DDB when multiple vendor requests occur simultaneously.
        // Uniquely identifies this turn based on conversation, user text, and parent message.
        val uniqueContent = "${activeConversationId}-${prompt}-${selectedResponseId ?: ""}-user"
        val deterministicId = java.util.UUID.nameUUIDFromBytes(uniqueContent.toByteArray()).toString()

        val message = Message(
            messageId = deterministicId,
            conversationId = activeConversationId,
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

        // For streaming, we currently support only the first config or iterate?
        // Let's take the first one for now.
        val config = aiConfig.firstOrNull()
        if (config == null) {
            logger.warn("No AI config provided in request")
            return@flow
        }

        // Build conversation history for prompt
        val promptWithContext = includeThreadContextInPrompt(
            message.conversationId,
            message.messageId,
            message.text
        )

        val sb = StringBuilder()

        try {
            generateTextStream(
                config.aiVendor,
                config.model,
                promptWithContext,
                message.systemPrompt,
                message.customerId
            ).collect { chunk ->
                sb.append(chunk)
                emit(chunk)
            }
        } catch (e: Exception) {
            logger.error("Error during streaming", e)
            throw e
        } finally {
            val responseText = sb.toString()
            if (responseText.isNotEmpty()) {
                val responseMessage = Message(
                    conversationId = message.conversationId,
                    customerId = message.customerId,
                    client = message.client,
                    role = "assistant",
                    text = responseText,
                    previousMessageId = message.messageId,
                    aiConfig = listOf(config),
                    systemPrompt = message.systemPrompt
                )
                conversationService.addMessageInConversation(responseMessage)
            }
        }

    }

    private suspend fun generateTextStream(
        aiVendor: AIVendor,
        model: String,
        prompt: String,
        systemPrompt: String?,
        customerId: String
    ): kotlinx.coroutines.flow.Flow<String> {
        val apiKey = fetchApiKey(
            aiVendor,
            customerId,
            customerProfileService
        )

        return kotlinx.coroutines.flow.flow {
             when (aiVendor) {
                AIVendor.OPENAI -> {
                    val params = aiRequestService.buildOpenAIRequest(
                        prompt,
                        model,
                        systemPrompt ?: ""
                    )
                    val httpClient = aiRequestService.getOpenAIProvider(apiKey)
                    httpClient.generateResponseStream(
                        com.genflowly.aicallerlib.models.openai.OpenAIRequest(
                            params
                        )
                    ).collect { emit(it.getText()) }
                }

                AIVendor.GEMINI -> {
                    val params = aiRequestService.buildGeminiRequest(
                        prompt,
                        model,
                        systemPrompt ?: ""
                    )
                    val httpClient = aiRequestService.getGeminiProvider(apiKey)
                    httpClient.generateResponseStream(
                        com.genflowly.aicallerlib.models.gemini.GeminiRequest(
                            params
                        )
                    ).collect { emit(it.getText() ?: "") }
                }

                AIVendor.CLAUDE -> {
                    val params = aiRequestService.buildClaudeRequest(
                        prompt,
                        model,
                        systemPrompt ?: ""
                    )
                    val httpClient = aiRequestService.getClaudeProvider(apiKey)
                    httpClient.generateResponseStream(
                        com.genflowly.aicallerlib.models.claude.ClaudeRequest(
                            params
                        )
                    ).collect { emit(it.getText()) }
                }
            }
        }
    }
}
