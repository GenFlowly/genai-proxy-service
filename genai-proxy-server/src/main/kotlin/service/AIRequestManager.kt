package service

import com.genflowly.aicallerlib.models.AIUsageMetadata
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.aicallerlib.models.claude.ClaudeUsageMetadata
import com.genflowly.aicallerlib.models.gemini.GeminiUsageMetadata
import com.genflowly.aicallerlib.models.openai.OpenAIUsageMetadata
import com.genflowly.service.AIRequestService
import com.genflowly.service.ConversationAccessDeniedException
import com.genflowly.service.ConversationService
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.PromptGenerationService
import com.genflowly.service.ConversationMessage
import com.genflowly.service.RetrievalService
import com.genflowly.service.StreamChunk
import com.genflowly.utils.fetchApiKey
import models.AIConfig
import models.AIGenerateResult
import models.GenerateTextRequest
import models.Message
import org.slf4j.LoggerFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers

class AIRequestManager(
    private val aiRequestService: AIRequestService,
    private val customerProfileService: CustomerProfileService,
    private val conversationService: ConversationService,
    private val promptGenerationService: PromptGenerationService,
    private val retrievalService: RetrievalService
) {
    private val logger = LoggerFactory.getLogger("AIRequestManager")

    private val defaultAIModel: String = "gpt-5"
    private val defaultAIVendor: AIVendor = AIVendor.OPENAI

    private fun vendorToProviderString(vendor: AIVendor): String = when (vendor) {
        AIVendor.OPENAI -> "openai"
        AIVendor.GEMINI -> "gemini"
        AIVendor.CLAUDE -> "anthropic"
    }

    private fun vendorToCredentialKey(vendor: AIVendor): String = when (vendor) {
        AIVendor.OPENAI -> "openai_api_key"
        AIVendor.GEMINI -> "gemini_api_key"
        AIVendor.CLAUDE -> "anthropic_api_key"
    }


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
            // Enforce that the caller can write to this conversation. New conversations
            // just created above have no shares yet, so this check only applies when
            // continuing an existing one.
            val role = conversationService.getConversationRole(conversationId, customerId)
            if (role != "OWNER" && role != "EDIT") {
                throw ConversationAccessDeniedException("Customer $customerId cannot write to conversation $conversationId")
            }
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

        // Step 2 - Create message object (retrieval-server handles RAG during generation)
        val message = Message(
            conversationId = conversationId,
            customerId = customerId,
            client = client,
            role = "user",
            text = userRequestRawPrompt,
            previousMessageId = selectedResponseId,
            aiConfig = aiConfig,
            systemPrompt = systemPrompt,
            instructionId = instructionId.takeIf { it.isNotBlank() },
            instructionVersion = instructionVersion.takeIf { it.isNotBlank() }
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
                        maxTokens = aiConfig.maxTokens ?: 4096,
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
        maxTokens: Int = 4096,
        message: Message
    ): Message {
        val apiKey = fetchApiKey(aiVendor, message.customerId, customerProfileService)
            ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

        val thread = getThreadContext(message.conversationId, message.messageId)
        val conversationHistory = thread.map { ConversationMessage(role = it.role, content = it.text) }

        val result = retrievalService.retrieveAndGenerate(
            customerId = message.customerId,
            client = message.client,
            query = message.text,
            llmCredentials = mapOf(vendorToCredentialKey(aiVendor) to apiKey),
            llmProvider = vendorToProviderString(aiVendor),
            llmModel = model,
            llmMaxTokens = maxTokens,
            conversationHistory = conversationHistory,
            systemPrompt = message.systemPrompt
        )

        val responseMessage = Message(
            conversationId = message.conversationId,
            customerId = message.customerId,
            client = message.client,
            role = "assistant",
            text = result.text ?: "No response received. Please try again.",
            previousMessageId = message.messageId,
            aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
            systemPrompt = message.systemPrompt,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            totalTokens = result.totalTokens
        )

        conversationService.addMessageInConversation(responseMessage)
        return responseMessage
    }
    
    suspend fun generateText(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): AIGenerateResult {
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

            // Step 4: Extract text and usage metadata
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

        } catch (e: Exception) {
            val errorText = "Error occurred while generating response from $aiVendor - ${e.message}"
            return AIGenerateResult(text = errorText, inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null)
        }
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

        val instructionResp = customerProfileService.getInstructionVersion(customerId, instructionId, instructionVersion.toIntOrNull() ?: 1)
        val systemPrompt = instructionResp?.instruction ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId = getConversationId(customerId, client, conversationId)

        // Step 2 - Create message object (retrieval-server handles RAG during generation)
        // Use deterministic ID to prevent duplication in DDB on retries.
        val uniqueContent = "${activeConversationId}-${userRequestRawPrompt}-${selectedResponseId ?: ""}-user"
        val deterministicId = java.util.UUID.nameUUIDFromBytes(uniqueContent.toByteArray()).toString()

        val message = Message(
            messageId = deterministicId,
            conversationId = activeConversationId,
            customerId = customerId,
            client = client,
            role = "user",
            text = userRequestRawPrompt,
            previousMessageId = selectedResponseId,
            aiConfig = aiConfig,
            systemPrompt = systemPrompt,
            instructionId = instructionId.takeIf { it.isNotBlank() },
            instructionVersion = instructionVersion.takeIf { it.isNotBlank() }
        )

        // Step 3 - Add message request to conversation
        conversationService.addMessageInConversation(message)
        logger.info("Added Message id {} to conversation", message.messageId)

        val config = aiConfig.firstOrNull() ?: run {
            logger.warn("No AI config provided in request")
            return StreamExecutionResult(activeConversationId, deterministicId, kotlinx.coroutines.flow.emptyFlow(), "")
        }

        // Fetch API key before building the flow so auth errors surface immediately
        val apiKey = fetchApiKey(config.aiVendor, customerId, customerProfileService)
            ?: throw IllegalArgumentException("API key not found for vendor: ${config.aiVendor}")
        val llmCredentials = mapOf(vendorToCredentialKey(config.aiVendor) to apiKey)
        val llmProvider = vendorToProviderString(config.aiVendor)

        // Fetch conversation thread so the LLM sees full history (message is already saved above)
        val thread = getThreadContext(activeConversationId, deterministicId)
        val conversationHistory = thread.map { ConversationMessage(role = it.role, content = it.text) }

        // Pre-calculate the deterministic response ID to send as a response header immediately
        val responseUniqueContent = "${deterministicId}-response-${config.aiVendor}"
        val responseMessageId = java.util.UUID.nameUUIDFromBytes(responseUniqueContent.toByteArray()).toString()

        val flow = kotlinx.coroutines.flow.flow {
            val sb = StringBuilder()
            var capturedUsage: StreamChunk.Usage? = null
            try {
                retrievalService.retrieveAndGenerateStream(
                    customerId = customerId,
                    client = client,
                    query = userRequestRawPrompt,
                    llmCredentials = llmCredentials,
                    llmProvider = llmProvider,
                    llmModel = config.model,
                    llmMaxTokens = config.maxTokens ?: 4096,
                    conversationHistory = conversationHistory,
                    systemPrompt = systemPrompt
                ).collect { chunk ->
                    when (chunk) {
                        is StreamChunk.Content -> {
                            sb.append(chunk.text)
                            emit("{\"t\":\"c\",\"v\":${chunk.text.toJsonStringValue()}}\n")
                        }
                        is StreamChunk.Thinking -> {
                            emit("{\"t\":\"k\",\"v\":${chunk.text.toJsonStringValue()}}\n")
                        }
                        is StreamChunk.Usage -> capturedUsage = chunk
                    }
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
                logger.info(
                    "Stream completed for conversation {}. Length: {} input_tokens={} output_tokens={} total_tokens={}",
                    message.conversationId, responseText.length,
                    capturedUsage?.inputTokens, capturedUsage?.outputTokens, capturedUsage?.totalTokens
                )
                if (responseText.isNotEmpty()) {
                    val responseMessage = Message(
                        messageId = responseMessageId,
                        conversationId = message.conversationId,
                        customerId = message.customerId,
                        client = message.client,
                        role = "assistant",
                        text = responseText,
                        previousMessageId = message.messageId,
                        aiConfig = listOf(config),
                        systemPrompt = message.systemPrompt,
                        inputTokens = capturedUsage?.inputTokens,
                        outputTokens = capturedUsage?.outputTokens,
                        totalTokens = capturedUsage?.totalTokens
                    )
                    conversationService.addMessageInConversation(responseMessage)
                }
            }
        }

        return StreamExecutionResult(
            activeConversationId,
            deterministicId,
            flow,
            responseMessageId
        )
    }

    /**
     * Internal streaming helper that emits pairs of (text chunk, raw AIResponse).
     * The AIResponse is included so callers can extract usage metadata from
     * provider-specific chunks (e.g. the final chunk that contains token counts).
     */
    private suspend fun generateTextStreamWithUsage(
        aiVendor: AIVendor,
        model: String,
        messages: List<Message>,
        systemPrompt: String?,
        customerId: String
    ): kotlinx.coroutines.flow.Flow<Pair<String, com.genflowly.aicallerlib.models.AIResponse?>> {
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
                        ).collect { response -> emit(Pair(response.getText(), response)) }
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
                                ).collect { response ->
                                    logger.info("Gemini stream chunk received: ${response.getText()?.take(20)}...")
                                    emit(Pair(response.getText() ?: "", response))
                                }
                            }
                        } catch (e: TimeoutCancellationException) {
                            val timeoutMsg = "Request timed out while waiting for Gemini. This likely indicates you are rate limited (429) and the SDK is retrying silently. Please try again later."
                            logger.warn(timeoutMsg)
                            emit(Pair(timeoutMsg, null))
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
                        ).collect { response -> emit(Pair(response.getText(), response)) }
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
                      emit(Pair(rateLimitMsg, null))
                 } else if (isApiKeyExpired) {
                      val expiredMsg = "Please update your API key.\nDetails: $message"
                      logger.info("Emitting expired key message inside flow: {}", expiredMsg)
                      emit(Pair(expiredMsg, null))
                 } else {
                      throw e
                 }
             }
        }.flowOn(kotlinx.coroutines.Dispatchers.IO)
    }

    suspend fun createConversationTitle(
        conversationId: String,
        customerId: String,
        prompt: String,
        instructionName: String? = null
    ): String? {
        return try {
            val titleMessage = Message(
                conversationId = "title-generation",
                text = "I am starting a conversation with $instructionName " +
                        "using" +
                        "this prompt - $prompt. Create a short title for this" +
                        "conversation. Just give the title",
                client = "internal",
                role = "user",
                customerId = customerId,
                systemPrompt = "",
                aiConfig = listOf(AIConfig(defaultAIVendor, defaultAIModel)),
                previousMessageId = null
            )

            val result = generateText(
                defaultAIVendor,
                defaultAIModel,
                listOf(titleMessage),
                "",
                customerId
            )

            // Strip any surrounding quotes the LLM may include (e.g. "My Title" -> My Title)
            val title = result.text.trim().removePrefix("\"").removeSuffix("\"").trim().take(200)
            if (title.isNotBlank()) {
                conversationService.updateConversationTitle(conversationId, customerId, title)
                logger.info("Conversation title set for $conversationId: '$title'")
                title
            } else {
                null
            }
        } catch (e: Exception) {
            logger.warn("Failed to generate conversation title for $conversationId: ${e.message}")
            null
        }
    }

    suspend fun generateInstructionPersona(
        instructionText: String,
        customerId: String
    ): String {

        return generateText(
            defaultAIVendor,
            defaultAIModel,
            listOf(
                Message(
                    conversationId = "instruction-creation",
                    text = instructionText,
                    client = "internal",
                    role = "user",
                    customerId = customerId,
                    systemPrompt = "",
                    aiConfig = listOf(AIConfig(defaultAIVendor, defaultAIModel)),
                    previousMessageId = null
                )
            ),
            "Create a persona for this system instructions.\n" +
                    "\n" +
                    "The role should be generic enough to be understood what are it's key technical skills but also specific enough to not make it a broad term.\n" +
                    "\n" +
                    "\n" +
                    "Return only the name of Role, nothing else",
            customerId
        ).text
    }
}

private fun String.toJsonStringValue(): String = buildString {
    append('"')
    for (c in this@toJsonStringValue) {
        when (c) {
            '"'  -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(c)
        }
    }
    append('"')
}
