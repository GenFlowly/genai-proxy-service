package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.PromptGenerationService
import com.genflowly.utils.fetchApiKey
import models.AIConfig
import models.GenerateTextRequest
import models.Message
import org.slf4j.LoggerFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException

class AIRequestManager(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService,
    private val conversationService: ConversationService,
    private val promptGenerationService: PromptGenerationService
) {
    private val logger = LoggerFactory.getLogger("AIRequestManager")


    private suspend fun getThreadContext(
        conversationId: String,
        messageId: String
    ): List<Message> {
        return conversationService.getMessageThread(conversationId, messageId)
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
        instructionId: String,
        instructionVersion: String,
        userRequestRawPrompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String

    ): List<Message> {

        val versionInt = instructionVersion.toIntOrNull() ?: 1
        val instructionResp = customerProfileService.getInstructionVersion(customerId, instructionId, versionInt)
        val systemPrompt = instructionResp?.instruction ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val conversationId =
            getConversationId(customerId, client, conversationId)

        // Step 2 - Add context to prompt
        val prompt = promptGenerationService.generatePrompt(customerId, userRequestRawPrompt, systemPrompt)

        // Step 3 - Create message object
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

        // Step 4 - Add message request to conversation
        conversationService.addMessageInConversation(message)

        logger.info("Added Message id {} to conversation", message.messageId)

        // Step 5 - Handle request for each AI vendor in loop
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

        // Step 6 - Return message response list
        return responseMessageList
    }


    suspend fun fetchResponseFromAIVendor(
        aiVendor: AIVendor,
        model: String,
        message: Message
    ): Message {

        var responseText: String?

        // Step 1: Build conversation history for prompt
        val messages = getThreadContext(
            message.conversationId,
            message.messageId
        )

        logger.info("Sending {} messages context", messages.size)
        
        responseText = generateText(
            aiVendor, 
            model, 
            messages, 
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
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): String {
        try {
            // Step 1: Fetch API key for 3rd party AI vendor
            val apiKey = fetchApiKey(
                aiVendor,
                customerId,
                customerProfileService
            ) ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

            // Step 2: Start timer for 3rd party API call
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

    data class StreamExecutionResult(
        val conversationId: String,
        val messageId: String,
        val flow: kotlinx.coroutines.flow.Flow<String>,
        val responseMessageId: String
    )

    suspend fun processTextGenerateStreamRequest(
        aiConfig: List<AIConfig>,
        instructionId: String,
        instructionVersion: String,
        userRequestRawPrompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String
    ): StreamExecutionResult {

        val versionInt = instructionVersion.toIntOrNull() ?: 1
        val instructionResp = customerProfileService.getInstructionVersion(customerId, instructionId, versionInt)
        val systemPrompt = instructionResp?.instruction ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            getConversationId(customerId, client, conversationId)

        val prompt = promptGenerationService.generatePrompt(customerId, userRequestRawPrompt, systemPrompt)

        // Step 2 - Create message object
        // Use Deterministic ID to prevent duplication in DDB when multiple vendor requests occur simultaneously.
        // Uniquely identifies this turn based on conversation, user text, and parent message.
        val uniqueContent = "${activeConversationId}-${userRequestRawPrompt}-${selectedResponseId ?: ""}-user"
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
        val config = aiConfig.firstOrNull() ?: run {
             logger.warn("No AI config provided in request")
             return StreamExecutionResult(activeConversationId, deterministicId, kotlinx.coroutines.flow.emptyFlow(), "")
        }

        // Build conversation history for prompt
        val messages = getThreadContext(
            message.conversationId,
            message.messageId
        )

        // Pre-calculate the deterministic Response ID so we can send it to the client headers
        // Format: userMessageId + "response" + vendor
        val responseUniqueContent = "${deterministicId}-response-${config.aiVendor}"
        val responseMessageId = java.util.UUID.nameUUIDFromBytes(responseUniqueContent.toByteArray()).toString()

        val flow = kotlinx.coroutines.flow.flow {
            val sb = StringBuilder()
            try {
                generateTextStream(
                    config.aiVendor,
                    config.model,
                    messages,
                    message.systemPrompt,
                    message.customerId
                ).collect { chunk ->
                    sb.append(chunk)
                    emit(chunk)
                }
            } catch (e: java.io.IOException) {
                logger.warn("Stream disrupted (client likely disconnected): {}", e.message)
                throw e
            } catch (e: Exception) {
                logger.error("Error during streaming", e)
                emit("\n\n[Error: ${e.message}]")
                throw e
            } finally {
                val responseText = sb.toString()
                logger.info("Stream flow completed for conversation {}. Total length: {}", message.conversationId, responseText.length)
                logger.info("Received response from $config - $responseText")

                if (responseText.isNotEmpty()) {
                    val responseMessage = Message(
                        messageId = responseMessageId, // Use the pre-calculated ID
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

        return StreamExecutionResult(activeConversationId, deterministicId, flow, responseMessageId)
    }

    private suspend fun generateTextStream(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): kotlinx.coroutines.flow.Flow<String> {
        val apiKey = fetchApiKey(
            aiVendor,
            customerId,
            customerProfileService
        ) ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

        return kotlinx.coroutines.flow.flow {
             try {
                 when (aiVendor) {
                    AIVendor.OPENAI -> {
                        val params = aiRequestService.buildOpenAIRequest(
                            messages,
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
                        logger.info("Building Gemini request")
                        val params = aiRequestService.buildGeminiRequest(
                            messages,
                            model,
                            systemPrompt ?: ""
                        )
                        logger.info("Getting Gemini provider")
                        val httpClient = aiRequestService.getGeminiProvider(apiKey)
                        logger.info("Starting Gemini stream collection with timeout")

                        try {
                            withTimeout(5000L) { // 20 seconds timeout to
                                // catch silent SDK retries
                                httpClient.generateResponseStream(
                                    com.genflowly.aicallerlib.models.gemini.GeminiRequest(
                                        params
                                    )
                                ).collect { 
                                    logger.info("Gemini stream chunk received: ${it.getText()?.take(20)}...")
                                    emit(it.getText() ?: "") 
                                }
                            }
                        } catch (e: TimeoutCancellationException) {
                            val timeoutMsg = "Request timed out while waiting for Gemini. This likely indicates you are rate limited (429) and the SDK is retrying silently. Please try again later."
                            logger.warn(timeoutMsg)
                            emit(timeoutMsg)
                        }
                        
                        logger.info("Gemini stream collection finished")
                    }
    
                    AIVendor.CLAUDE -> {
                        val params = aiRequestService.buildClaudeRequest(
                            messages,
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
             } catch (e: Exception) {
                 logger.error("Error during streaming definition", e)
                 
                 val message = e.message ?: ""
                 val isRateLimit = message.contains("429") || 
                                   message.contains("Quota exceeded") || 
                                   (e.javaClass.name.contains("ClientException") && message.contains("429"))

                 val isApiKeyExpired = message.contains("API key expired") || message.contains("400")

                 if (isRateLimit) {
                      val rateLimitMsg = "Rate limit exceeded for your API key. Please retry later.\nDetails: $message"
                      logger.info("Emitting rate limit message inside flow: {}", rateLimitMsg)
                      emit(rateLimitMsg)
                 } else if (isApiKeyExpired) {
                      val expiredMsg = "Please update your API key.\nDetails: $message"
                      logger.info("Emitting expired key message inside flow: {}", expiredMsg)
                      emit(expiredMsg)
                 } else {
                      throw e
                 }
             }
        }.flowOn(kotlinx.coroutines.Dispatchers.IO)
    }
}
