package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.di.AppScope
import com.genflowly.models.RequestType
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.LearnedFactView
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.encoding.EncodingMemoryData
import com.genflowly.models.encoding.EncodingSaveMemoryRequest
import com.genflowly.observability.Metrics
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.delay
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
    private val appScope: AppScope,
    /**
     * When true (development and lower environments), log lines may include
     * conversation/memory content; in production only ids and counts are
     * logged.
     */
    private val logContent: Boolean
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
     * [MESSAGES_PER_EXTRACTION] messages. A turn below the threshold is NOT
     * dropped: it schedules a deferred flush [DEBOUNCE_FLUSH_DELAY_MS] later
     * that extracts whatever accumulated, so short conversations still learn
     * and the outcome lands on the turn that produced it (within the client's
     * learned-facts polling window).
     */
    fun maybeExtractFromConversationAsync(
        customerId: String,
        conversationId: String,
        bearerToken: String?,
        /**
         * Assistant message this exchange produced. When set, the extraction
         * outcome is written onto it as learnedFactsJson — "[]" on every
         * terminal skipped/failed path (the marker that stops client polling),
         * the added facts on a successful run. The debounced path defers
         * instead of writing the marker, keeping the client polling until the
         * flush resolves.
         */
        responseMessageId: String? = null,
    ) {
        appScope.launch {
            runConversationExtraction(customerId, conversationId, bearerToken, responseMessageId, deferred = false)
        }
    }

    private suspend fun runConversationExtraction(
        customerId: String,
        conversationId: String,
        bearerToken: String?,
        responseMessageId: String?,
        /** True on the delayed flush pass — the message-count threshold no longer applies. */
        deferred: Boolean,
    ) {
        suspend fun markNothingLearned() {
            if (responseMessageId == null) return
            try {
                conversationService.setMessageLearnedFacts(conversationId, responseMessageId, "[]")
            } catch (e: Exception) {
                Metrics.count("memory_learned_facts_write_failure_total")
                logger.warn("Failed to write learned-facts marker for $responseMessageId: ${e.message}")
            }
        }
        suspend fun skip(reason: String, detail: String = "") {
            Metrics.count(
                "memory_extraction_skipped_total", 1.0,
                "status" to reason, "source" to SOURCE_CONVERSATION
            )
            logger.info("Memory extraction skipped for conversation {}: {}{}", conversationId, reason, detail)
            markNothingLearned()
        }
        try {
            logger.info(
                "Memory extraction triggered for conversation {} by customer {} (deferred={})",
                conversationId, customerId, deferred
            )
            if (!memoryService.isMemoryEnabled(customerId)) {
                skip("disabled"); return
            }

            val latestMessageId = conversationService.getLatestMessageId(conversationId)
            if (latestMessageId == null) { skip("empty"); return }
            val thread = conversationService.getMessageThread(conversationId, latestMessageId)
            val processed = memoryRepository.getConversationExtractionMark(customerId, conversationId)
            val newMessages = thread.size - (processed ?: 0)
            if (newMessages < 1) {
                // Nothing unprocessed (e.g. a parallel-vendor duplicate trigger,
                // or an interim run beat the flush to it) — terminal marker.
                skip(if (deferred) "flush_noop" else "debounced", " (0 new messages)"); return
            }
            val threshold = if (processed == null) FIRST_EXTRACTION_MIN_MESSAGES else MESSAGES_PER_EXTRACTION
            if (!deferred && newMessages < threshold) {
                // Below the batching threshold: don't drop the turn — flush it
                // after a short delay instead. No "[]" marker is written here,
                // so the client's learning indicator keeps polling and the
                // flush outcome (which runs well inside the poll timeout)
                // lands on THIS response.
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to "debounced", "source" to SOURCE_CONVERSATION
                )
                logger.info(
                    "Memory extraction debounced for conversation {} ({} new message(s), threshold {}) — flushing in {}ms",
                    conversationId, newMessages, threshold, DEBOUNCE_FLUSH_DELAY_MS
                )
                delay(DEBOUNCE_FLUSH_DELAY_MS)
                runConversationExtraction(customerId, conversationId, bearerToken, responseMessageId, deferred = true)
                return
            }

            Metrics.tracked("memory_extraction", "source" to SOURCE_CONVERSATION) {
                    // Claim the window before the LLM call so concurrent completions
                    // of parallel turns don't double-extract; a failed run forfeits
                    // its window, which the next exchange re-opens.
                    memoryRepository.setConversationExtractionMark(customerId, conversationId, thread.size)

                    val transcript = thread.takeLast(MAX_TRANSCRIPT_MESSAGES).joinToString("\n") { message ->
                        val speaker = if (message.role == "assistant") "Assistant" else "User"
                        "$speaker: ${message.text.take(MAX_MESSAGE_CHARS)}"
                    }
                    if (logContent) {
                        logger.info("Memory extraction transcript for conversation {}:\n{}", conversationId, transcript)
                    }
                    val added = extract(customerId, transcript, MemorySourceType.CONVERSATION, conversationId, bearerToken)
                    if (responseMessageId != null) {
                        val factsJson = json.encodeToString(added.map { LearnedFactView(it.memoryId, it.text) })
                        conversationService.setMessageLearnedFacts(conversationId, responseMessageId, factsJson)
                    }
                }
        } catch (e: Exception) {
            logger.warn("Memory extraction from conversation $conversationId failed: ${e.message}")
            markNothingLearned()
        }
    }

    /** Note trigger, called on the final (encode=true) save of an editing session. */
    fun maybeExtractFromNoteAsync(customerId: String, noteKey: String, title: String?, content: String, bearerToken: String?) {
        appScope.launch {
            fun skip(reason: String) {
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to reason, "source" to SOURCE_NOTE
                )
                logger.info("Memory extraction skipped for note {}: {}", noteKey, reason)
            }
            try {
                if (content.trim().length < MIN_NOTE_CHARS) { skip("too_short"); return@launch }
                if (!memoryService.isMemoryEnabled(customerId)) { skip("disabled"); return@launch }
                val noteText = listOfNotNull(title?.takeIf { it.isNotBlank() && it != "Untitled" }, content)
                    .joinToString("\n").take(MAX_NOTE_CHARS)
                Metrics.tracked("memory_extraction", "source" to SOURCE_NOTE) {
                    extract(customerId, noteText, MemorySourceType.NOTE, noteKey, bearerToken)
                }
            } catch (e: Exception) {
                logger.warn("Memory extraction from note $noteKey failed: ${e.message}")
            }
        }
    }

    /** Runs extraction and returns the memories ADDed by this run. */
    private suspend fun extract(
        customerId: String,
        content: String,
        sourceType: MemorySourceType,
        sourceId: String,
        bearerToken: String?
    ): List<CustomerMemory> {
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

        val source = sourceType.name.lowercase()
        if (logContent) {
            logger.info("Memory-extraction agent output for {} {}: {}", source, sourceId, result.text)
        }
        val operations = parseOperations(result.text, source) ?: return emptyList()
        if (operations.isEmpty()) {
            logger.info("Memory extraction returned no operations for {} {}", source, sourceId)
            return emptyList()
        }

        val existingById = existing.associateBy { it.memoryId }
        val addedMemories = mutableListOf<CustomerMemory>()
        var applied = 0
        operations.forEach { op ->
            val opName = op.op.lowercase().takeIf { it in KNOWN_OPERATIONS } ?: "unknown"
            try {
                val changed = applyOperation(customerId, op, existingById, sourceType, sourceId, bearerToken, addedMemories)
                if (changed) applied++
                Metrics.count(
                    "memory_operation_total", 1.0,
                    "operation" to opName, "status" to if (changed) "ok" else "noop"
                )
            } catch (e: Exception) {
                Metrics.count("memory_operation_total", 1.0, "operation" to opName, "status" to "error")
                logger.warn("Failed to apply memory operation ${op.op} for $customerId: ${e.message}")
            }
        }
        if (applied > 0) {
            logger.info("Applied $applied memory operation(s) for customer $customerId from $source $sourceId")
        } else {
            logger.info("No memory operation changed stored state for $source $sourceId (${operations.size} proposed)")
        }
        return addedMemories
    }

    /** Returns true when the operation changed stored state. */
    private suspend fun applyOperation(
        customerId: String,
        op: MemoryOperation,
        existingById: Map<String, CustomerMemory>,
        sourceType: MemorySourceType,
        sourceId: String,
        bearerToken: String?,
        addedMemories: MutableList<CustomerMemory> = mutableListOf()
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
                addedMemories.add(memory)
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
            val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
            // Memories are extracted from conversations, so they follow the
            // conversations-category default.
            val model = prefs?.embeddingModelConversations ?: prefs?.embeddingModel
            if (collectionsEnsured.add(customerId)) {
                // Customers onboarded before the MEMORY data type existed have
                // no memory collection yet; creation is idempotent.
                encodingServerClient.ensureCollections(customerId, "Bearer $bearerToken", model)
            }
            val now = Instant.now().toString()
            encodingServerClient.encodeMemory(
                EncodingSaveMemoryRequest(
                    client = "memory",
                    modelType = EmbeddingConstants.modelTypeFor(model),
                    modelName = model ?: EmbeddingConstants.MODEL_NAME,
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
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "encode")
            logger.error("Failed to encode memory ${memory.memoryId} for $customerId", e)
        }
    }

    private suspend fun deleteMemoryVector(customerId: String, memoryId: String) {
        try {
            retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
        } catch (e: Exception) {
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "delete")
            logger.error("Failed to delete vectors for memory $memoryId", e)
        }
    }

    private fun parseOperations(raw: String, source: String): List<MemoryOperation>? {
        val cleaned = raw.trim()
            .removePrefix("```json").removePrefix("```")
            .removeSuffix("```").trim()
        if (cleaned.isBlank()) {
            Metrics.count("memory_extraction_unparseable_total", 1.0, "source" to source)
            logger.warn("Blank memory-extraction output")
            return null
        }
        return try {
            json.decodeFromString<MemoryOperations>(cleaned).operations
        } catch (e: Exception) {
            Metrics.count("memory_extraction_unparseable_total", 1.0, "source" to source)
            val snippet = if (logContent) " (${cleaned.take(120)}...)" else " (${cleaned.length} chars)"
            logger.warn("Unparseable memory-extraction output$snippet: ${e.message}")
            null
        }
    }

    companion object {
        private const val SOURCE_CONVERSATION = "conversation"
        private const val SOURCE_NOTE = "note"
        private val KNOWN_OPERATIONS = setOf("add", "update", "delete")

        private const val FIRST_EXTRACTION_MIN_MESSAGES = 2
        private const val MESSAGES_PER_EXTRACTION = 4

        /**
         * Delay before a below-threshold turn is flushed anyway. Must resolve
         * (delay + extraction time) inside the client's learned-facts polling
         * window (60s — see useLearnedFacts.ts) so the pending indicator
         * settles with the real outcome instead of timing out.
         */
        private const val DEBOUNCE_FLUSH_DELAY_MS = 30_000L
        private const val MAX_TRANSCRIPT_MESSAGES = 12
        private const val MAX_MESSAGE_CHARS = 2000
        private const val MIN_NOTE_CHARS = 30
        private const val MAX_NOTE_CHARS = 8000
        private const val MAX_MEMORY_CHARS = 300
    }
}
