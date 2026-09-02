package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.di.AppScope
import com.genflowly.models.RequestType
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.encoding.EncodingMemoryData
import com.genflowly.models.encoding.EncodingSaveMemoryRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory

@Serializable
private data class MemoryOperations(val operations: List<MemoryOperation> = emptyList())

@Serializable
private data class MemoryOperation(
    val op: String,
    val text: String? = null,
    val kind: String? = null,
    val category: String? = null,
    val memoryId: String? = null
)

@Serializable
private data class ExistingMemoryView(
    val memoryId: String,
    val kind: String,
    val category: String?,
    val text: String
)

/**
 * Learns durable facts about a customer from their conversations and notes via
 * the MEMORY_EXTRACTION agent (RequestAgentMap, or the bundled default). The
 * agent sees existing memories plus new content and returns ADD/UPDATE/DELETE
 * operations, so the memory set converges instead of accumulating duplicates.
 *
 * All entry points are fire-and-forget (appScope) — extraction runs after the
 * user-facing work has completed and must never affect it.
 */
class MemoryExtractionService(
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val memoryRepository: MemoryRepository,
    private val memoryService: MemoryService,
    private val conversationService: ConversationService,
    private val customerProfileRepository: CustomerProfileRepository,
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(MemoryExtractionService::class.java)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    // Customers whose vector collections were already ensured by this process.
    // ensureCollections is idempotent server-side; this only trims HTTP calls.
    private val collectionsEnsured = ConcurrentHashMap.newKeySet<String>()

    /**
     * Debounced conversation trigger, called after an exchange completes. Runs
     * extraction when the conversation gained enough messages since the last
     * run: the first pass after one full exchange, later passes every
     * [MESSAGES_PER_EXTRACTION] messages.
     */
    fun maybeExtractFromConversationAsync(customerId: String, conversationId: String, bearerToken: String?) {
        appScope.launch {
            try {
                if (!memoryService.isMemoryEnabled(customerId)) return@launch

                val latestMessageId = conversationService.getLatestMessageId(conversationId) ?: return@launch
                val thread = conversationService.getMessageThread(conversationId, latestMessageId)
                val processed = memoryRepository.getConversationExtractionMark(customerId, conversationId)
                val newMessages = thread.size - (processed ?: 0)
                val threshold = if (processed == null) FIRST_EXTRACTION_MIN_MESSAGES else MESSAGES_PER_EXTRACTION
                if (newMessages < threshold) return@launch

                // Claim the window before the LLM call so concurrent completions
                // of parallel turns don't double-extract; a failed run forfeits
                // its window, which the next exchange re-opens.
                memoryRepository.setConversationExtractionMark(customerId, conversationId, thread.size)

                val transcript = thread.takeLast(MAX_TRANSCRIPT_MESSAGES).joinToString("\n") { message ->
                    val speaker = if (message.role == "assistant") "Assistant" else "User"
                    "$speaker: ${message.text.take(MAX_MESSAGE_CHARS)}"
                }
                extract(customerId, transcript, MemorySourceType.CONVERSATION, conversationId, bearerToken)
            } catch (e: Exception) {
                logger.warn("Memory extraction from conversation $conversationId failed: ${e.message}")
            }
        }
    }

    /** Note trigger, called on the final (encode=true) save of an editing session. */
    fun maybeExtractFromNoteAsync(customerId: String, noteKey: String, title: String?, content: String, bearerToken: String?) {
        appScope.launch {
            try {
                if (content.trim().length < MIN_NOTE_CHARS) return@launch
                if (!memoryService.isMemoryEnabled(customerId)) return@launch
                val noteText = listOfNotNull(title?.takeIf { it.isNotBlank() && it != "Untitled" }, content)
                    .joinToString("\n").take(MAX_NOTE_CHARS)
                extract(customerId, noteText, MemorySourceType.NOTE, noteKey, bearerToken)
            } catch (e: Exception) {
                logger.warn("Memory extraction from note $noteKey failed: ${e.message}")
            }
        }
    }

    private suspend fun extract(
        customerId: String,
        content: String,
        sourceType: MemorySourceType,
        sourceId: String,
        bearerToken: String?
    ) {
        val existing = memoryRepository.getMemories(customerId)
        val existingJson = json.encodeToString(existing.map {
            ExistingMemoryView(it.memoryId, it.kind.name, it.category, it.text)
        })

        val agent = agentResolutionService.resolve(RequestType.MEMORY_EXTRACTION, customerId)
        val result = generationAgentExecutor.executeWithCustomerKey(
            agent = agent,
            variables = mapOf(
                "existingMemories" to existingJson,
                "sourceType" to sourceType.name.lowercase(),
                "content" to content
            ),
            customerId = customerId,
            conversationId = "memory-extraction"
        )

        val operations = parseOperations(result.text) ?: return
        if (operations.isEmpty()) return

        val existingById = existing.associateBy { it.memoryId }
        var applied = 0
        operations.forEach { op ->
            try {
                if (applyOperation(customerId, op, existingById, sourceType, sourceId, bearerToken)) applied++
            } catch (e: Exception) {
                logger.warn("Failed to apply memory operation ${op.op} for $customerId: ${e.message}")
            }
        }
        if (applied > 0) {
            memoryService.invalidate(customerId)
            logger.info("Applied $applied memory operation(s) for customer $customerId from ${sourceType.name.lowercase()} $sourceId")
        }
    }

    /** Returns true when the operation changed stored state. */
    private suspend fun applyOperation(
        customerId: String,
        op: MemoryOperation,
        existingById: Map<String, CustomerMemory>,
        sourceType: MemorySourceType,
        sourceId: String,
        bearerToken: String?
    ): Boolean = when (op.op.uppercase()) {
        "ADD" -> {
            val text = op.text?.trim()?.take(MAX_MEMORY_CHARS)
            if (text.isNullOrBlank()) false else {
                val kind = op.kind?.uppercase()
                    ?.let { runCatching { MemoryKind.valueOf(it) }.getOrNull() } ?: MemoryKind.EPISODIC
                val memory = memoryRepository.createMemory(
                    customerId = customerId,
                    text = text,
                    kind = kind,
                    category = op.category?.take(50),
                    sourceType = sourceType,
                    sourceId = sourceId
                )
                encodeMemoryVector(customerId, memory, bearerToken)
                true
            }
        }
        "UPDATE" -> {
            val target = op.memoryId?.let { existingById[it] }
            val text = op.text?.trim()?.take(MAX_MEMORY_CHARS)
            if (target == null || text.isNullOrBlank()) false
            else if (memoryRepository.updateMemoryText(customerId, target.memoryId, text)) {
                deleteMemoryVector(customerId, target.memoryId)
                encodeMemoryVector(customerId, target.copy(text = text), bearerToken)
                true
            } else false
        }
        "DELETE" -> {
            val target = op.memoryId?.let { existingById[it] }
            if (target != null && memoryRepository.deleteMemory(customerId, target.memoryId)) {
                deleteMemoryVector(customerId, target.memoryId)
                true
            } else false
        }
        else -> {
            logger.warn("Ignoring unknown memory operation '${op.op}' for $customerId")
            false
        }
    }

    /**
     * Best-effort push into the embedding pipeline for semantic recall.
     * Memories are tiny and rewritten in place, so they always take the
     * realtime path — never the batch accumulator.
     */
    private suspend fun encodeMemoryVector(customerId: String, memory: CustomerMemory, bearerToken: String?) {
        if (bearerToken == null) return
        try {
            if (collectionsEnsured.add(customerId)) {
                // Customers onboarded before the MEMORY data type existed have
                // no memory collection yet; creation is idempotent.
                encodingServerClient.ensureCollections(customerId, "Bearer $bearerToken")
            }
            val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
            val now = Instant.now().toString()
            encodingServerClient.encodeMemory(
                EncodingSaveMemoryRequest(
                    client = "memory",
                    modelType = EmbeddingConstants.MODEL_TYPE,
                    modelName = prefs?.embeddingModel ?: EmbeddingConstants.MODEL_NAME,
                    data = EncodingMemoryData(
                        memory_key = memory.memoryId,
                        memoryKey = memory.memoryId,
                        memory_value = memory.text,
                        memoryValue = memory.text,
                        title = "[memory] ${memory.category ?: memory.kind.name.lowercase()}",
                        created_at = now,
                        createdAt = now
                    )
                ),
                bearerToken
            )
        } catch (e: Exception) {
            logger.error("Failed to encode memory ${memory.memoryId} for $customerId", e)
        }
    }

    private suspend fun deleteMemoryVector(customerId: String, memoryId: String) {
        try {
            retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
        } catch (e: Exception) {
            logger.error("Failed to delete vectors for memory $memoryId", e)
        }
    }

    private fun parseOperations(raw: String): List<MemoryOperation>? {
        val cleaned = raw.trim()
            .removePrefix("```json").removePrefix("```")
            .removeSuffix("```").trim()
        if (cleaned.isBlank()) return null
        return try {
            json.decodeFromString<MemoryOperations>(cleaned).operations
        } catch (e: Exception) {
            logger.warn("Unparseable memory-extraction output (${cleaned.take(120)}...): ${e.message}")
            null
        }
    }

    companion object {
        private const val FIRST_EXTRACTION_MIN_MESSAGES = 2
        private const val MESSAGES_PER_EXTRACTION = 4
        private const val MAX_TRANSCRIPT_MESSAGES = 12
        private const val MAX_MESSAGE_CHARS = 2000
        private const val MIN_NOTE_CHARS = 30
        private const val MAX_NOTE_CHARS = 8000
        private const val MAX_MEMORY_CHARS = 300
    }
}
