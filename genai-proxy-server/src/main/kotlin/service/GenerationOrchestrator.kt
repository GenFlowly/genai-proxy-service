package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.retrieval.ConversationMessage
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.PayloadToolDefinition
import com.genflowly.models.retrieval.PayloadToolResult
import com.genflowly.models.retrieval.PayloadToolResultImage
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.models.AIConfig
import com.genflowly.models.AttachmentRef
import com.genflowly.models.GenerateTextRequest
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_ATTACHMENT_SIZE_BYTES
import com.genflowly.models.Message
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import org.slf4j.LoggerFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString

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
    private val s3Provider: S3Provider,
    private val modelCatalogService: ModelCatalogService
) {
    private val logger = LoggerFactory.getLogger("GenerationOrchestrator")

    private suspend fun getThreadContext(
        conversationId: String,
        messageId: String
    ): List<Message> {
        return conversationService.getMessageThread(conversationId, messageId)
    }

    /**
     * Rejects attachments the caller doesn't own (key must sit under the
     * authenticated customer's prefix) or that were never actually uploaded /
     * exceed the size limit. Runs only for the current turn's attachments —
     * history attachments were validated when their message was created.
     */
    private suspend fun validateAttachments(attachments: List<AttachmentRef>, customerId: String) {
        if (attachments.isEmpty()) return
        require(attachments.size <= MAX_ATTACHMENTS_PER_MESSAGE) {
            "At most $MAX_ATTACHMENTS_PER_MESSAGE attachments are allowed per message"
        }
        val ownedPrefix = "customers/$customerId/"
        for (attachment in attachments) {
            require(attachment.s3Key.startsWith(ownedPrefix)) {
                "Attachment ${attachment.attachmentId} does not belong to the authenticated customer"
            }
            val info = s3Provider.head(attachment.s3Key)
                ?: throw IllegalArgumentException("Attachment ${attachment.attachmentId} has not been uploaded")
            require(info.sizeBytes <= MAX_ATTACHMENT_SIZE_BYTES) {
                "Attachment ${attachment.attachmentId} exceeds the $MAX_ATTACHMENT_SIZE_BYTES byte limit"
            }
        }
    }

    private fun List<AttachmentRef>.toImageRefs(): List<ImageRef> =
        map { ImageRef(s3Key = it.s3Key, mediaType = it.mediaType) }

    private fun Message.toConversationMessage(): ConversationMessage =
        ConversationMessage(
            role = role,
            content = text,
            images = attachments.toImageRefs(),
            toolCalls = toolCallsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() },
            toolResults = toolResultsJson?.let { runCatching { jsonParser.parseToJsonElement(it) }.getOrNull() }
        )

    private fun List<ToolDefinition>.toPayloadTools(): List<PayloadToolDefinition> =
        map {
            PayloadToolDefinition(
                name = it.name,
                description = it.description,
                parameters = it.parameters,
                type = it.type,
                options = it.options
            )
        }

    private fun List<ToolResult>.toPayloadToolResults(): List<PayloadToolResult> =
        map { r ->
            PayloadToolResult(
                toolCallId = r.toolCallId,
                content = r.content,
                images = r.images.map { img ->
                    PayloadToolResultImage(data = img.data, s3Key = img.s3Key, mediaType = img.mediaType)
                }
            )
        }

    /**
     * Snake-cased JSON of tool results as persisted on the user Message and replayed
     * in later turns. Inline base64 screenshots are stripped (marked omitted) — raw
     * screenshots would blow DynamoDB's 400 KB item limit, and stale screenshots
     * shouldn't be replayed anyway. S3-referenced images keep their reference.
     */
    private fun List<ToolResult>.toResultsJson(): String? =
        takeIf { it.isNotEmpty() }?.let { results ->
            jsonParser.encodeToString(results.map { r ->
                PayloadToolResult(
                    toolCallId = r.toolCallId,
                    content = r.content,
                    images = r.images.map { img ->
                        if (img.data != null) {
                            PayloadToolResultImage(mediaType = img.mediaType, omitted = true)
                        } else {
                            PayloadToolResultImage(s3Key = img.s3Key, mediaType = img.mediaType)
                        }
                    }
                )
            })
        }

    /**
     * Native tool types (computer use etc.) are Anthropic-only; tool-result image
     * S3 keys must belong to the authenticated customer.
     */
    private fun validateTools(
        tools: List<ToolDefinition>,
        toolResults: List<ToolResult>,
        vendors: List<AIVendor>,
        customerId: String
    ) {
        val nativeTypes = tools.mapNotNull { it.type }.filter { it != "function" }
        if (nativeTypes.isNotEmpty()) {
            require(vendors.all { it == AIVendor.CLAUDE }) {
                "Native tool types $nativeTypes are supported on Claude only — use function tools for other vendors"
            }
        }
        val ownedPrefix = "customers/$customerId/"
        for (result in toolResults) {
            for (img in result.images) {
                require(img.data != null || img.s3Key != null) {
                    "Tool result image must provide either data or s3Key"
                }
                img.s3Key?.let {
                    require(it.startsWith(ownedPrefix)) {
                        "Tool result image s3Key does not belong to the authenticated customer"
                    }
                }
            }
        }
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

    /**
     * Resolve the effective (instructionId, version) for a generation request.
     * An explicit selection is returned as-is; a blank selection falls back to
     * the customer's default (preferred / last-used / SYSTEM). Returns the
     * original blank values if nothing resolves — safe, yields no instruction.
     */
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
        toolResults: List<ToolResult> = emptyList()

    ): List<Message> {

        validateAttachments(attachments, customerId)
        validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)

        // An explicit selection wins; otherwise resolve the customer's default
        // (preferred / last-used, ultimately the SYSTEM instruction). Resolution
        // returns the full instruction, so there is no second fetch here.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        val systemPrompt = instructionResp?.instruction ?: ""
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            getConversationId(customerId, client, conversationId)

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
                        toolResults = toolResults
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
        toolResults: List<ToolResult> = emptyList()
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
            toolResults = toolResults.toPayloadToolResults()
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
        customerId: String,
        agentic: Boolean = true,
        attachments: List<AttachmentRef> = emptyList(),
        tools: List<ToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<ToolResult> = emptyList()
    ): StreamExecutionResult {

        validateAttachments(attachments, customerId)
        validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)

        // An explicit selection wins; otherwise resolve the customer's default
        // (preferred / last-used, ultimately the SYSTEM instruction). Resolution
        // returns the full instruction, so there is no second fetch here.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        val systemPrompt = instructionResp?.instruction ?: ""
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId = getConversationId(customerId, client, conversationId)

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
            return StreamExecutionResult(activeConversationId, deterministicId, kotlinx.coroutines.flow.emptyFlow(), "")
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
                    toolResults = toolResults.toPayloadToolResults()
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
            responseMessageId
        )
    }

    companion object {
        private val jsonParser = Json { ignoreUnknownKeys = true }
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
