package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.toConversationMessage
import com.genflowly.models.retrieval.toImageRefs
import com.genflowly.models.retrieval.toPayloadToolResults
import com.genflowly.models.retrieval.toPayloadTools
import com.genflowly.models.retrieval.toResultsJson
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.models.AIConfig
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import org.slf4j.LoggerFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/**
 * Orchestrates the primary text-generation flows (batch + streaming): request
 * validation, instruction resolution, conversation lifecycle, message
 * persistence, per-vendor fan-out and delegation to the retrieval-server.
 * Utility generations (titles, personas) live elsewhere — see
 * UtilityGenerationService and its callers.
 */
class GenerationOrchestrator(
    private val customerCredentialsService: CustomerCredentialsService,
    private val instructionService: InstructionService,
    private val conversationService: ConversationService,
    private val retrievalService: RetrievalServerClient,
    private val requestValidator: GenerationRequestValidator,
    private val modelCatalogService: ModelCatalogService,
    private val memoryService: MemoryService
) {
    private val logger = LoggerFactory.getLogger("GenerationOrchestrator")

    private suspend fun getThreadContext(
        conversationId: String,
        messageId: String
    ): List<Message> {
        return conversationService.getMessageThread(conversationId, messageId)
    }

    /**
     * Resolve the instruction to use for a generation request, returning the full
     * instruction (no second fetch downstream). An explicit selection is fetched
     * directly; a blank selection resolves the customer's default (preferred /
     * last-used / SYSTEM). The default is an enhancement, not a requirement — any
     * failure to resolve it degrades to no instruction (plain chat), never a 500.
     */
    private suspend fun resolveInstruction(
        customerId: String,
        instructionId: String,
        instructionVersion: String
    ): InstructionResponse? {
        if (instructionId.isNotBlank()) {
            return instructionService.getInstructionVersion(customerId, instructionId, instructionVersion.toIntOrNull() ?: 1)
        }
        return try {
            instructionService.resolveDefaultInstruction(customerId)
        } catch (e: Exception) {
            logger.warn("Failed to resolve default instruction for customer {}; proceeding with none", customerId, e)
            null
        }
    }

    suspend fun processTextGenerateRequest(
        aiConfig: List<AIConfig>,
        instructionId: String,
        instructionVersion: String,
        userRequestRawPrompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String,
        agentic: Boolean = true,
        attachments: List<AttachmentRef> = emptyList(),
        tools: List<ToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<ToolResult> = emptyList(),
        responseSchema: kotlinx.serialization.json.JsonObject? = null

    ): List<Message> {

        requestValidator.validateAttachments(attachments, customerId)
        requestValidator.validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)
        require(responseSchema == null || tools.isEmpty()) {
            "responseSchema and tools are mutually exclusive — structured output reserves the vendor's tool channel"
        }

        // An explicit selection wins; otherwise resolve the customer's default
        // (preferred / last-used, ultimately the SYSTEM instruction). Resolution
        // returns the full instruction, so there is no second fetch here.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        // Learned CORE memories ride on the system prompt so durable user facts
        // shape every response, with or without retrieval.
        val systemPrompt = memoryService.withMemoryBlock(customerId, instructionResp?.instruction ?: "")
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            conversationService.resolveWritableConversationId(customerId, client, conversationId)

        var actualPreviousMessageId = selectedResponseId
        if (actualPreviousMessageId.isNullOrBlank() && !conversationId.isNullOrBlank()) {
            actualPreviousMessageId = conversationService.getLatestMessageId(activeConversationId)
        }

        // Step 2 - Create message object (retrieval-server handles RAG during generation)
        val message = Message(
            conversationId = activeConversationId,
            customerId = customerId,
            client = client,
            role = "user",
            text = userRequestRawPrompt,
            attachments = attachments,
            toolResultsJson = toolResults.toResultsJson(),
            previousMessageId = actualPreviousMessageId,
            aiConfig = aiConfig,
            systemPrompt = systemPrompt,
            instructionId = effectiveInstructionId.takeIf { it.isNotBlank() },
            instructionVersion = effectiveInstructionVersion.takeIf { it.isNotBlank() }
        )

        // Step 4 - Add message request to conversation
        conversationService.addMessageInConversation(message)

        logger.info("Added Message id {} to conversation", message.messageId)

        // Step 5 - Track instruction usage (strict: counts each unique conversation+instruction once)
        if (effectiveInstructionId.isNotBlank()) {
            instructionService.trackInstructionUsage(customerId, activeConversationId, effectiveInstructionId)
        }
        val responseMessageList = coroutineScope {
            message.aiConfig.map { aiConfig ->
                async {
                    fetchResponseFromAIVendor(
                        aiVendor = aiConfig.aiVendor,
                        model = aiConfig.model,
                        maxTokens = aiConfig.maxTokens,
                        message = message,
                        agentic = agentic,
                        tools = tools,
                        toolChoice = toolChoice,
                        toolResults = toolResults,
                        responseSchema = responseSchema
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
        maxTokens: Int? = null,
        message: Message,
        agentic: Boolean = true,
        tools: List<ToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<ToolResult> = emptyList(),
        responseSchema: kotlinx.serialization.json.JsonObject? = null
    ): Message {
        val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(aiVendor, message.customerId)
            ?: throw IllegalArgumentException("API key not found for vendor: $aiVendor")

        val thread = if (message.previousMessageId.isNullOrBlank()) {
            listOf(message)
        } else {
            getThreadContext(message.conversationId, message.previousMessageId) + message
        }
        val conversationHistory = thread.map { it.toConversationMessage() }

        val resolvedMaxTokens = modelCatalogService.resolveMaxTokens(
            vendor = aiVendor, model = model, requested = maxTokens, streaming = false
        )

        val result = retrievalService.retrieveAndGenerate(
            customerId = message.customerId,
            client = message.client,
            query = message.text,
            llmCredentials = mapOf(aiVendor.toCredentialKey() to apiKey),
            llmProvider = aiVendor.toProviderString(),
            llmModel = model,
            llmMaxTokens = resolvedMaxTokens,
            conversationHistory = conversationHistory,
            systemPrompt = message.systemPrompt,
            agentic = agentic,
            queryImages = message.attachments.toImageRefs(),
            tools = tools.toPayloadTools(),
            toolChoice = toolChoice,
            toolResults = toolResults.toPayloadToolResults(),
            responseSchema = responseSchema
        )

        val responseMessage = Message(
            conversationId = message.conversationId,
            customerId = message.customerId,
            client = message.client,
            role = "assistant",
            // A pure tool-call response has no text — don't fake an error message
            text = result.text ?: if (result.toolCallsJson != null) "" else "No response received. Please try again.",
            toolCallsJson = result.toolCallsJson,
            previousMessageId = message.messageId,
            aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
            systemPrompt = message.systemPrompt,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            totalTokens = result.totalTokens,
            tokensReadFromCache = result.tokensReadFromCache
        )

        conversationService.addMessageInConversation(responseMessage)
        return responseMessage
    }
    
    data class StreamExecutionResult(
        val conversationId: String,
        val messageId: String,
        val flow: kotlinx.coroutines.flow.Flow<String>,
        val responseMessageId: String,
        /**
         * Instruction actually applied to this turn — the explicit selection or
         * the server-resolved default. Echoed to the client (X-Instruction-Id)
         * so the UI can reflect a default the caller never sent. Blank when the
         * turn ran without an instruction.
         */
        val appliedInstructionId: String = "",
        val appliedInstructionVersion: String = ""
    )

    suspend fun processTextGenerateStreamRequest(
        aiConfig: List<AIConfig>,
        instructionId: String,
        instructionVersion: String,
        userRequestRawPrompt: String,
        conversationId: String?,
        selectedResponseId: String?,
        client: String,
        customerId: String,
        agentic: Boolean = true,
        attachments: List<AttachmentRef> = emptyList(),
        tools: List<ToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<ToolResult> = emptyList(),
        responseSchema: kotlinx.serialization.json.JsonObject? = null
    ): StreamExecutionResult {

        requestValidator.validateAttachments(attachments, customerId)
        requestValidator.validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)
        require(responseSchema == null || tools.isEmpty()) {
            "responseSchema and tools are mutually exclusive — structured output reserves the vendor's tool channel"
        }

        // An explicit selection wins; otherwise resolve the customer's default
        // (preferred / last-used, ultimately the SYSTEM instruction). Resolution
        // returns the full instruction, so there is no second fetch here.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        // Learned CORE memories ride on the system prompt so durable user facts
        // shape every response, with or without retrieval.
        val systemPrompt = memoryService.withMemoryBlock(customerId, instructionResp?.instruction ?: "")
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId = conversationService.resolveWritableConversationId(customerId, client, conversationId)

        var actualPreviousMessageId = selectedResponseId
        // A parallel per-vendor stream call for the same turn may have already
        // persisted this turn's user message — reuse it instead of chaining a
        // duplicate off it (which fragments history into per-vendor pairs).
        var existingUserMessage: Message? = null
        if (actualPreviousMessageId.isNullOrBlank() && !conversationId.isNullOrBlank()) {
            existingUserMessage = conversationService.findActiveTurnUserMessage(
                activeConversationId, userRequestRawPrompt, attachments.map { it.attachmentId },
                toolResults.toResultsJson()
            )
            actualPreviousMessageId = if (existingUserMessage != null) {
                existingUserMessage.previousMessageId
            } else {
                conversationService.getLatestMessageId(activeConversationId)
            }
        }

        // Step 2 - Create message object (retrieval-server handles RAG during generation)
        // Use deterministic ID to prevent duplication in DDB on retries. Attachment IDs
        // and tool results are part of the hash so same-text turns don't collide
        // (tool continuations often carry an empty prompt).
        val attachmentsFingerprint = attachments.joinToString(",") { it.attachmentId }
        val toolResultsFingerprint = toolResults.joinToString(",") { it.toolCallId }
        val uniqueContent = "${activeConversationId}-${userRequestRawPrompt}-${actualPreviousMessageId ?: ""}-${attachmentsFingerprint}-${toolResultsFingerprint}-user"
        val deterministicId = existingUserMessage?.messageId
            ?: java.util.UUID.nameUUIDFromBytes(uniqueContent.toByteArray()).toString()

        val message = Message(
            messageId = deterministicId,
            conversationId = activeConversationId,
            customerId = customerId,
            client = client,
            role = "user",
            text = userRequestRawPrompt,
            attachments = attachments,
            toolResultsJson = toolResults.toResultsJson(),
            previousMessageId = actualPreviousMessageId,
            aiConfig = aiConfig,
            systemPrompt = systemPrompt,
            instructionId = effectiveInstructionId.takeIf { it.isNotBlank() },
            instructionVersion = effectiveInstructionVersion.takeIf { it.isNotBlank() }
        )

        // Step 3 - Add message request to conversation (skip when a parallel
        // vendor stream already persisted this turn's user message)
        if (existingUserMessage == null) {
            conversationService.addMessageInConversation(message)
            logger.info("Added Message id {} to conversation", message.messageId)
        } else {
            logger.info("Reusing user message id {} for parallel vendor stream", message.messageId)
        }

        // Step 4 - Track instruction usage (strict: counts each unique conversation+instruction once)
        if (effectiveInstructionId.isNotBlank()) {
            instructionService.trackInstructionUsage(customerId, activeConversationId, effectiveInstructionId)
        }

        val config = aiConfig.firstOrNull() ?: run {
            logger.warn("No AI config provided in request")
            return StreamExecutionResult(
                activeConversationId, deterministicId, kotlinx.coroutines.flow.emptyFlow(), "",
                effectiveInstructionId, effectiveInstructionVersion
            )
        }

        // Fetch API key before building the flow so auth errors surface immediately
        val apiKey = customerCredentialsService.getCustomerApiKeyForVendor(config.aiVendor, customerId)
            ?: throw IllegalArgumentException("API key not found for vendor: ${config.aiVendor}")

        val llmCredentials = mapOf(config.aiVendor.toCredentialKey() to apiKey)
        val llmProvider = config.aiVendor.toProviderString()

        // Fetch conversation thread so the LLM sees full history (message is already saved above)
        val thread = if (message.previousMessageId.isNullOrBlank()) {
            listOf(message)
        } else {
            getThreadContext(activeConversationId, message.previousMessageId) + message
        }
        val conversationHistory = thread.map { it.toConversationMessage() }

        // Pre-calculate the deterministic response ID to send as a response header immediately
        val responseUniqueContent = "${deterministicId}-response-${config.aiVendor}"
        val responseMessageId = java.util.UUID.nameUUIDFromBytes(responseUniqueContent.toByteArray()).toString()

        val flow = kotlinx.coroutines.flow.flow {
            val sb = StringBuilder()
            var capturedUsage: StreamChunk.Usage? = null
            var capturedThinkingDurationMs: Long? = null
            var capturedToolCallsJson: String? = null
            var capturedWebSourcesJson: String? = null
            var success = false
            try {
                retrievalService.retrieveAndGenerateStream(
                    customerId = customerId,
                    client = client,
                    query = userRequestRawPrompt,
                    llmCredentials = llmCredentials,
                    llmProvider = llmProvider,
                    llmModel = config.model,
                    llmMaxTokens = modelCatalogService.resolveMaxTokens(
                        vendor = config.aiVendor,
                        model = config.model,
                        requested = config.maxTokens,
                        streaming = true
                    ),
                    conversationHistory = conversationHistory,
                    systemPrompt = systemPrompt,
                    agentic = agentic,
                    queryImages = attachments.toImageRefs(),
                    tools = tools.toPayloadTools(),
                    toolChoice = toolChoice,
                    toolResults = toolResults.toPayloadToolResults(),
                    responseSchema = responseSchema
                ).collect { chunk ->
                    when (chunk) {
                        is StreamChunk.Content -> {
                            sb.append(chunk.text)
                            emit("{\"t\":\"c\",\"v\":${chunk.text.toJsonStringValue()}}\n")
                        }
                        is StreamChunk.Thinking -> {
                            emit("{\"t\":\"k\",\"v\":${chunk.text.toJsonStringValue()}}\n")
                        }
                        is StreamChunk.ThinkingDuration -> {
                            capturedThinkingDurationMs = chunk.millis
                            emit("{\"t\":\"kd\",\"v\":${chunk.millis}}\n")
                        }
                        is StreamChunk.ToolCalls -> {
                            capturedToolCallsJson = chunk.json
                            // chunk.json is already a JSON array — embed as-is
                            emit("{\"t\":\"tc\",\"v\":${chunk.json}}\n")
                        }
                        is StreamChunk.WebSources -> {
                            capturedWebSourcesJson = chunk.json
                            // chunk.json is already a JSON array — embed as-is
                            emit("{\"t\":\"ws\",\"v\":${chunk.json}}\n")
                        }
                        is StreamChunk.Usage -> capturedUsage = chunk
                    }
                }
                success = true
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
                if (success && (responseText.isNotEmpty() || capturedToolCallsJson != null)) {
                    val responseMessage = Message(
                        messageId = responseMessageId,
                        conversationId = message.conversationId,
                        customerId = message.customerId,
                        client = message.client,
                        role = "assistant",
                        text = responseText,
                        toolCallsJson = capturedToolCallsJson,
                        webSourcesJson = capturedWebSourcesJson,
                        previousMessageId = message.messageId,
                        aiConfig = listOf(config),
                        systemPrompt = message.systemPrompt,
                        inputTokens = capturedUsage?.inputTokens,
                        outputTokens = capturedUsage?.outputTokens,
                        totalTokens = capturedUsage?.totalTokens,
                        tokensReadFromCache = capturedUsage?.tokensReadFromCache,
                        thinkingDurationMs = capturedThinkingDurationMs
                    )
                    conversationService.addMessageInConversation(responseMessage)
                }
            }
        }

        return StreamExecutionResult(
            activeConversationId,
            deterministicId,
            flow,
            responseMessageId,
            effectiveInstructionId,
            effectiveInstructionVersion
        )
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
