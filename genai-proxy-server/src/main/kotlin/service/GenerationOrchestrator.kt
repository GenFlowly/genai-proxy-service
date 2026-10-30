package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.ToolDefinition
import com.genflowly.models.ToolResult
import com.genflowly.models.retrieval.StreamChunk
import com.genflowly.models.retrieval.toNdjsonFrame
import com.genflowly.models.retrieval.doneNdjsonFrame
import com.genflowly.models.retrieval.parseGeneratedArtifacts
import com.genflowly.models.retrieval.toConversationMessage
import com.genflowly.models.retrieval.toFileRefs
import com.genflowly.models.retrieval.toImageRefs
import com.genflowly.models.retrieval.toPayloadToolResults
import com.genflowly.models.retrieval.toPayloadTools
import com.genflowly.models.retrieval.toResultsJson
import com.genflowly.config.AppConfig
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.RunsClient
import com.genflowly.repository.GraphRepository
import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.di.AppScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.launch
import com.genflowly.models.AIConfig
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import com.genflowly.observability.Metrics
import com.genflowly.observability.metricVendor
import org.slf4j.LoggerFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
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
    private val memoryService: MemoryService,
    private val costCalculationService: CostCalculationService,
    private val graphRepository: GraphRepository,
    private val appScope: AppScope,
    private val runsClient: RunsClient,
    private val appConfig: AppConfig,
    private val conversationManagementService: ConversationManagementService
) {
    private val logger = LoggerFactory.getLogger("GenerationOrchestrator")

    /**
     * In-flight streamed generations by responseMessageId, for explicit
     * client cancellation. Entries remove themselves on completion.
     */
    private data class ActiveGeneration(val customerId: String, val job: kotlinx.coroutines.Job)
    private val activeGenerations = java.util.concurrent.ConcurrentHashMap<String, ActiveGeneration>()
    // responseMessageId -> durable run_id, for runs started on the /runs path. Lets
    // cancelGeneration also stop the background run on the retrieval-server.
    private val activeRunIds = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * True cancel for a streamed generation: stops the upstream LLM work (the
     * background job survives client disconnects by design, so closing the
     * HTTP stream alone no longer stops it). The partial text streamed so far
     * is persisted. Returns false when nothing is running under that id for
     * this customer (already finished, or not the caller's generation).
     */
    suspend fun cancelGeneration(customerId: String, responseMessageId: String): Boolean {
        val active = activeGenerations[responseMessageId] ?: return false
        if (active.customerId != customerId) return false
        logger.info("Cancelling generation {} for customer {}", responseMessageId, customerId)
        active.job.cancel(kotlinx.coroutines.CancellationException("Cancelled by user"))
        // Durable path: stop the background run on the retrieval-server too — the
        // job cancel only stops the proxy's relay, not the durable workflow.
        activeRunIds[responseMessageId]?.let { runId ->
            runCatching { runsClient.cancelRun(runId) }
                .onFailure { logger.warn("Failed to cancel durable run {}: {}", runId, it.message) }
        }
        return true
    }

    private suspend fun getThreadContext(
        conversationId: String,
        messageId: String
    ): List<Message> {
        return conversationService.getMessageThread(conversationId, messageId)
    }

    /**
     * Resolve the instruction to use for a generation request. A blank
     * selection means no persona — plain chat, no system prompt — rather than
     * guessing at a default.
     */
    private suspend fun resolveInstruction(
        customerId: String,
        instructionId: String,
        instructionVersion: String
    ): InstructionResponse? {
        if (instructionId.isBlank()) return null
        return instructionService.getInstructionVersion(customerId, instructionId, instructionVersion.toIntOrNull() ?: 1)
    }

    /**
     * Validates an explicitly requested agent (graph): it must exist, not be
     * deleted, and be owned by the customer or published by System. Same
     * access rule as GraphService.getAgent. No-op for null (server-side
     * default resolution).
     */
    private suspend fun validateAgentAccess(agentId: String?, customerId: String) {
        if (agentId.isNullOrBlank()) return
        val item = graphRepository.getCustomerGraph(agentId)
        val owner = item?.get("customerId")?.s()
        require(item != null && item["deletedAt"] == null && (owner == customerId || owner == SYSTEM_GRAPH_OWNER)) {
            "Agent '$agentId' not found."
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
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        useLearnedPreferences: Boolean = true,
        agentId: String? = null,
        projectId: String? = null

    ): List<Message> {

        requestValidator.validateAttachments(attachments, customerId)
        requestValidator.validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)
        require(responseSchema == null || tools.isEmpty()) {
            "responseSchema and tools are mutually exclusive — structured output reserves the vendor's tool channel"
        }
        validateAgentAccess(agentId, customerId)

        // Blank instructionId means no persona — plain chat, nothing to resolve.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        // Memory injection is a graph concern (the MEMORY node): here we only
        // make the governance call — request consent AND the account setting.
        val systemPrompt = instructionResp?.instruction ?: ""
        val memoryEnabled = useLearnedPreferences && memoryService.isMemoryEnabled(customerId)
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            conversationService.resolveWritableConversationId(customerId, client, conversationId, projectId)

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
                        thinkingLevel = aiConfig.thinkingLevel,
                        message = message,
                        agentic = agentic,
                        tools = tools,
                        toolChoice = toolChoice,
                        toolResults = toolResults,
                        responseSchema = responseSchema,
                        memoryEnabled = memoryEnabled,
                        agentId = agentId
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
        thinkingLevel: String? = null,
        message: Message,
        agentic: Boolean = true,
        tools: List<ToolDefinition> = emptyList(),
        toolChoice: String? = null,
        toolResults: List<ToolResult> = emptyList(),
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        memoryEnabled: Boolean = false,
        agentId: String? = null
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
            systemPrompt = ResponseFormatting.decorateSystemPrompt(
                message.systemPrompt, message.client, structuredOutput = responseSchema != null
            ),
            agentic = agentic,
            queryImages = message.attachments.toImageRefs(),
            queryFiles = message.attachments.toFileRefs(),
            tools = tools.toPayloadTools(),
            toolChoice = toolChoice,
            toolResults = toolResults.toPayloadToolResults(),
            responseSchema = responseSchema,
            memoryEnabled = memoryEnabled,
            graphId = agentId,
            thinkingLevel = thinkingLevel
        )

        val responseMessage = Message(
            conversationId = message.conversationId,
            customerId = message.customerId,
            client = message.client,
            role = "assistant",
            // A pure tool-call response has no text — don't fake an error message
            text = result.text ?: if (result.toolCallsJson != null) "" else
                result.errorMessage ?: "No response received. Please try again.",
            toolCallsJson = result.toolCallsJson,
            // Files built-in tools produced (e.g. generated PDFs) — served for
            // download through the existing attachment endpoint.
            attachments = parseGeneratedArtifacts(result.generatedArtifactsJson),
            previousMessageId = message.messageId,
            aiConfig = listOf(AIConfig(aiVendor = aiVendor, model = model)),
            systemPrompt = message.systemPrompt,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            totalTokens = result.totalTokens,
            tokensReadFromCache = result.tokensReadFromCache,
            tokensWrittenToCache = result.tokensWrittenToCache,
            reasoningTokens = result.reasoningTokens,
            costUsd = costCalculationService.computeCostUsd(
                aiVendor, model,
                TokenUsageBreakdown(
                    inputTokens = result.inputTokens,
                    outputTokens = result.outputTokens,
                    cacheReadTokens = result.tokensReadFromCache,
                    tokensWrittenToCache = result.tokensWrittenToCache
                )
            ),
            reasoningCostUsd = costCalculationService.computeReasoningCostUsd(
                aiVendor, model, result.reasoningTokens
            )
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
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        useLearnedPreferences: Boolean = true,
        agentId: String? = null,
        projectId: String? = null,
        regenerateMessageId: String? = null
    ): StreamExecutionResult {

        requestValidator.validateAttachments(attachments, customerId)
        requestValidator.validateTools(tools, toolResults, aiConfig.map { it.aiVendor }, customerId)
        require(responseSchema == null || tools.isEmpty()) {
            "responseSchema and tools are mutually exclusive — structured output reserves the vendor's tool channel"
        }
        validateAgentAccess(agentId, customerId)

        // Blank instructionId means no persona — plain chat, nothing to resolve.
        val instructionResp = resolveInstruction(customerId, instructionId, instructionVersion)
        // Memory injection is a graph concern (the MEMORY node): here we only
        // make the governance call — request consent AND the account setting.
        val systemPrompt = instructionResp?.instruction ?: ""
        // What the vendor sees; the messages persist the raw instruction only.
        val vendorSystemPrompt = ResponseFormatting.decorateSystemPrompt(
            systemPrompt, client, structuredOutput = responseSchema != null
        )
        val memoryEnabled = useLearnedPreferences && memoryService.isMemoryEnabled(customerId)
        val effectiveInstructionId = instructionResp?.id ?: ""
        val effectiveInstructionVersion = instructionResp?.version?.toString() ?: ""

        // Step 1 - Fetch existing or Create new conversation
        val activeConversationId =
            conversationService.resolveWritableConversationId(customerId, client, conversationId, projectId)

        // Brand-new UI conversation: kick off title generation now, in
        // parallel with the rest of the setup and the vendor stream, instead
        // of waiting for the client's POST /conversation/title round-trip
        // (that POST awaits this same job via the in-flight registry).
        // Blank-id gating means multi-vendor sibling streams (explicit id)
        // and tool continuations (blank prompt) never fire it; the client
        // gate keeps titles opt-in for developer API-key traffic.
        if (conversationId.isNullOrBlank() && userRequestRawPrompt.isNotBlank() &&
            client == AppConfig.CLIENT_REACT_APP
        ) {
            conversationManagementService.launchTitleGenerationAsync(
                activeConversationId, customerId, userRequestRawPrompt, instructionResp?.name
            )
        }

        var actualPreviousMessageId = selectedResponseId
        var existingUserMessage: Message? = null
        if (!regenerateMessageId.isNullOrBlank() && !conversationId.isNullOrBlank()) {
            // Regenerate click: the client told us exactly which turn's user
            // message to reuse — trust that id rather than guessing, and
            // chain the new AI reply off the SAME previousMessageId so it
            // lands in that turn's response group instead of starting a new one.
            existingUserMessage = conversationService.getMessage(activeConversationId, regenerateMessageId)
                ?.takeIf { it.role == "user" }
            actualPreviousMessageId = existingUserMessage?.previousMessageId ?: actualPreviousMessageId
        } else if (actualPreviousMessageId.isNullOrBlank() && !conversationId.isNullOrBlank()) {
            // A parallel per-vendor stream call for the same turn may have already
            // persisted this turn's user message — reuse it instead of chaining a
            // duplicate off it (which fragments history into per-vendor pairs).
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
            logger.info("Reusing existing user message id {} (regenerate or parallel vendor stream)", message.messageId)
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

        // Generation is DECOUPLED from the client connection: it runs on
        // appScope and pushes chunks through a buffered channel the HTTP
        // response merely relays. A client disconnect (mobile browsers kill
        // the stream when the app is backgrounded) cancels only the relay —
        // generation runs to completion and the response is persisted, so the
        // client can recover it by refetching the conversation.
        val chunkChannel = kotlinx.coroutines.channels.Channel<String>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val generationJob = appScope.launch {
            val emit: suspend (String) -> Unit = { chunkChannel.send(it) }
            val sb = StringBuilder()
            var capturedUsage: StreamChunk.Usage? = null
            var capturedErrorMessage: String? = null
            var capturedErrorType: String? = null
            var capturedThinkingDurationMs: Long? = null
            var capturedToolCallsJson: String? = null
            var capturedWebSourcesJson: String? = null
            var capturedGeneratedArtifactsJson: String? = null
            var capturedStopReason: String? = null
            val capturedThinkingSteps = mutableListOf<String>()
            var success = false
            var cancelled = false
            // The durable run this generation added to the conversation's pending
            // set (one entry per vendor), captured so the finally removes exactly
            // this one — not the sibling vendors' still-in-flight runs.
            var pendingRunEntry: com.genflowly.repository.PendingRun? = null
            try {
                val resolvedMaxTokens = modelCatalogService.resolveMaxTokens(
                    vendor = config.aiVendor,
                    model = config.model,
                    requested = config.maxTokens,
                    streaming = true
                )
                // Stateless /retrieve stream (the default path). Credentials are
                // sent in the request body.
                fun statelessStream(): Flow<StreamChunk> = retrievalService.retrieveAndGenerateStream(
                    customerId = customerId,
                    client = client,
                    query = userRequestRawPrompt,
                    llmCredentials = llmCredentials,
                    llmProvider = llmProvider,
                    llmModel = config.model,
                    llmMaxTokens = resolvedMaxTokens,
                    conversationHistory = conversationHistory,
                    systemPrompt = vendorSystemPrompt,
                    agentic = agentic,
                    queryImages = attachments.toImageRefs(),
                    queryFiles = attachments.toFileRefs(),
                    tools = tools.toPayloadTools(),
                    toolChoice = toolChoice,
                    toolResults = toolResults.toPayloadToolResults(),
                    responseSchema = responseSchema,
                    memoryEnabled = memoryEnabled,
                    graphId = agentId,
                    thinkingLevel = config.thinkingLevel
                )
                // Durable /runs path (flagged): start a durable background run and
                // reattach to its event stream. Credentials are NOT sent — the
                // retrieval-server resolves them from DynamoDB by customer_id, so
                // no secret is checkpointed (DURABLE_AGENTS_DBOS_PLAN §5.5). Only
                // the agentic case is routed here; a start failure degrades to the
                // stateless stream so a chat is never lost behind the flag.
                val generationFlow: Flow<StreamChunk> =
                    if (appConfig.durableRunsEnabled && agentic) {
                        val startedRunId = runsClient.startRun(
                            customerId = customerId,
                            client = client,
                            query = userRequestRawPrompt,
                            llmProvider = llmProvider,
                            llmModel = config.model,
                            llmMaxTokens = resolvedMaxTokens,
                            conversationHistory = conversationHistory,
                            systemPrompt = vendorSystemPrompt,
                            agentic = agentic,
                            queryImages = attachments.toImageRefs(),
                    queryFiles = attachments.toFileRefs(),
                            tools = tools.toPayloadTools(),
                            toolChoice = toolChoice,
                            toolResults = toolResults.toPayloadToolResults(),
                            responseSchema = responseSchema,
                            memoryEnabled = memoryEnabled,
                            graphId = agentId,
                            thinkingLevel = config.thinkingLevel
                        )
                        if (startedRunId != null) {
                            // Add this run to the conversation's pending set (one entry
                            // per vendor) for reload rediscovery ("assistant is mid-run");
                            // best-effort. Carries the deterministic responseMessageId +
                            // vendor/model so a reload renders and reattaches this card.
                            val entry = com.genflowly.repository.PendingRun(responseMessageId, startedRunId, config.aiVendor.name, config.model)
                            pendingRunEntry = entry
                            runCatching { conversationService.addPendingRun(customerId, activeConversationId, entry) }
                                .onFailure { logger.warn("Failed to persist pending run {} on conversation {}: {}", startedRunId, activeConversationId, it.message) }
                            activeRunIds[responseMessageId] = startedRunId  // for durable cancel
                            runsClient.streamRun(startedRunId)
                        } else {
                            logger.warn("Durable run start failed for conversation {} — falling back to stateless stream", activeConversationId)
                            statelessStream()
                        }
                    } else {
                        statelessStream()
                    }
                generationFlow.collect { chunk ->
                    // Capture for persistence; the client frame is produced by the
                    // shared StreamChunk.toNdjsonFrame() so the live and reattach
                    // streams emit an identical wire protocol.
                    when (chunk) {
                        is StreamChunk.Content -> sb.append(chunk.text)
                        // The round that just streamed ended in in-graph tool
                        // calls — its text was a preamble, not the answer.
                        // Drop it so the persisted message text holds only the
                        // final round; the preamble is kept on the thinking
                        // step (reasoning) inside capturedThinkingSteps.
                        is StreamChunk.ContentReset -> sb.setLength(0)
                        // Last writer wins: only the terminal round emits this,
                        // and after a content_reset any earlier round's reason is
                        // moot — so the final value is the turn's real stop reason.
                        is StreamChunk.StopReason -> capturedStopReason = chunk.reason
                        is StreamChunk.ThinkingStep -> capturedThinkingSteps.add(chunk.json)
                        is StreamChunk.ThinkingDuration -> capturedThinkingDurationMs = chunk.millis
                        is StreamChunk.ToolCalls -> capturedToolCallsJson = chunk.json
                        is StreamChunk.WebSources -> capturedWebSourcesJson = chunk.json
                        is StreamChunk.GeneratedArtifacts ->
                            // Multiple TOOL_EXECUTOR completions per turn are possible; accumulate.
                            capturedGeneratedArtifactsJson = mergeJsonArrays(capturedGeneratedArtifactsJson, chunk.json)
                        is StreamChunk.Usage -> capturedUsage = chunk
                        is StreamChunk.Error -> {
                            // Vendor failure surfaced mid-stream — the concise reason is
                            // relayed (below) and any partial text is kept and persisted.
                            capturedErrorMessage = chunk.message
                            capturedErrorType = chunk.errorType ?: "provider_error"
                            logger.warn(
                                "Generation {} failed mid-stream ({}): {}",
                                responseMessageId, capturedErrorType, chunk.message
                            )
                        }
                        is StreamChunk.AwaitingInput ->
                            logger.info("Generation {} awaiting input: {}", responseMessageId, chunk.json)
                        is StreamChunk.Thinking -> {}
                    }
                    chunk.toNdjsonFrame()?.let { emit(it) }
                }
                success = true
            } catch (e: kotlinx.coroutines.CancellationException) {
                // Explicit user cancel (cancelGeneration) — keep the partial text.
                cancelled = true
                logger.info("Generation {} cancelled — persisting {} streamed char(s)", responseMessageId, sb.length)
            } catch (e: Exception) {
                logger.error("Error during streaming", e)
                capturedErrorMessage = capturedErrorMessage ?: e.message
                capturedErrorType = capturedErrorType ?: "exception"
                runCatching { emit("\n\n[Error: ${e.message}]") }
            } finally {
                val responseText = sb.toString()
                logger.info(
                    "Stream completed for conversation {}. Length: {} input_tokens={} output_tokens={} total_tokens={}",
                    message.conversationId, responseText.length,
                    capturedUsage?.inputTokens, capturedUsage?.outputTokens, capturedUsage?.totalTokens
                )
                try {
                // NonCancellable: after a user cancel this coroutine is dead —
                // persistence of the partial text must still run.
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                if ((success || cancelled) && (responseText.isNotEmpty() || capturedToolCallsJson != null)) {
                    val responseMessage = Message(
                        messageId = responseMessageId,
                        conversationId = message.conversationId,
                        customerId = message.customerId,
                        client = message.client,
                        role = "assistant",
                        text = responseText,
                        toolCallsJson = capturedToolCallsJson,
                        webSourcesJson = capturedWebSourcesJson,
                        attachments = parseGeneratedArtifacts(capturedGeneratedArtifactsJson),
                        previousMessageId = message.messageId,
                        aiConfig = listOf(config),
                        systemPrompt = message.systemPrompt,
                        inputTokens = capturedUsage?.inputTokens,
                        outputTokens = capturedUsage?.outputTokens,
                        totalTokens = capturedUsage?.totalTokens,
                        tokensReadFromCache = capturedUsage?.tokensReadFromCache,
                        tokensWrittenToCache = capturedUsage?.tokensWrittenToCache,
                        reasoningTokens = capturedUsage?.reasoningTokens,
                        costUsd = capturedUsage?.let {
                            costCalculationService.computeCostUsd(
                                config.aiVendor, config.model,
                                TokenUsageBreakdown(
                                    inputTokens = it.inputTokens,
                                    outputTokens = it.outputTokens,
                                    cacheReadTokens = it.tokensReadFromCache,
                                    tokensWrittenToCache = it.tokensWrittenToCache
                                )
                            )
                        },
                        reasoningCostUsd = capturedUsage?.let {
                            costCalculationService.computeReasoningCostUsd(
                                config.aiVendor, config.model, it.reasoningTokens
                            )
                        },
                        thinkingDurationMs = capturedThinkingDurationMs,
                        thinkingStepsJson = thinkingStepsToJson(capturedThinkingSteps),
                        stopReason = capturedStopReason
                    )
                    conversationService.addMessageInConversation(responseMessage)
                }
                // Durable run finished — remove just this run from the pending set
                // (the other vendors' in-flight runs stay reattachable). No-op when
                // no durable run was started (stateless path / start failure).
                pendingRunEntry?.let { entry ->
                    runCatching { conversationService.removePendingRun(customerId, activeConversationId, entry) }
                }
                }
                } catch (e: Exception) {
                    logger.error("Failed to persist streamed response $responseMessageId", e)
                } finally {
                    // Terminal frame BEFORE close: without an explicit status the
                    // client can't tell "generation finished" from "the connection
                    // died mid-response" — both look like a clean stream end — and
                    // would silently treat a truncated answer as complete.
                    val doneStatus = when {
                        cancelled -> "cancelled"
                        capturedErrorMessage != null -> "error"
                        success -> "ok"
                        else -> "error"
                    }
                    // One increment per generation outcome. Failures carry the
                    // failure KIND as status (transport_error, rate_limit, …) —
                    // mid-stream deaths never become an HTTP 5xx (the response
                    // already streamed as 200), so this counter is the only
                    // alertable signal for them.
                    Metrics.count(
                        "generation_total", 1.0,
                        "status" to if (doneStatus == "error") (capturedErrorType ?: "error") else doneStatus,
                        "vendor" to config.aiVendor.metricVendor(),
                        "model" to config.model,
                    )
                    runCatching { emit(doneNdjsonFrame(doneStatus, capturedErrorMessage)) }
                    // Close AFTER persistence so a connected client's stream end
                    // implies the message is queryable (usage fetch follows it).
                    chunkChannel.close()
                }
            }
        }
        activeGenerations[responseMessageId] = ActiveGeneration(customerId, generationJob)
        generationJob.invokeOnCompletion {
            activeGenerations.remove(responseMessageId)
            activeRunIds.remove(responseMessageId)
        }
        val flow = chunkChannel.consumeAsFlow()

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

/**
 * Persisted form of a turn's thinking-step events ("ks" chunks, each already a
 * JSON object). Guards the DDB 400KB item limit: an oversized run (deep graph
 * cycles) keeps every step but drops the bulky prompt/response excerpts.
 */
private const val MAX_THINKING_STEPS_JSON_CHARS = 250_000

/** Concatenate two JSON arrays (either may be null); malformed input keeps the newer one. */
private fun mergeJsonArrays(existing: String?, incoming: String): String {
    if (existing.isNullOrBlank()) return incoming
    return runCatching {
        JsonArray(
            Json.parseToJsonElement(existing).jsonArray + Json.parseToJsonElement(incoming).jsonArray
        ).toString()
    }.getOrElse { incoming }
}

private fun thinkingStepsToJson(steps: List<String>): String? {
    if (steps.isEmpty()) return null
    val full = steps.joinToString(",", "[", "]")
    if (full.length <= MAX_THINKING_STEPS_JSON_CHARS) return full
    return runCatching {
        val stripped = Json.parseToJsonElement(full).jsonArray.map { el ->
            JsonObject(el.jsonObject.filterKeys { it != "prompt" && it != "response" })
        }
        JsonArray(stripped).toString()
    }.getOrNull()
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
