package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.di.AppScope
import com.genflowly.models.RequestType
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.LearnedFactView
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.observability.Metrics
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
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
 * the MEMORY_EXTRACTION agent (the published RequestAgentMap graph). The agent
 * sees existing memories plus new content and returns ADD/UPDATE/DELETE
 * operations — vendor-enforced to the operations JSON Schema, with blank or
 * unparseable output counting as a provider failure that advances the
 * customer-key failover.
 *
 * Conversation extraction is DURABLE: the trigger writes a pending-work row
 * (META#PENDING#<conversationId>) before anything runs, the extraction window
 * is a conditional claim → finalize/rollback on the mark row, and the
 * reconciler ([startPendingReconciler]) re-dispatches due rows across
 * restarts/failures with an attempts cap — so a failed or interrupted run on a
 * conversation's final exchange retries instead of being silently unlearned.
 * Note extraction (content not re-derivable later) keeps the simpler
 * run-once-now behavior.
 */
class MemoryExtractionService(
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val memoryRepository: MemoryRepository,
    private val memoryService: MemoryService,
    private val conversationService: ConversationService,
    private val customerProfileRepository: CustomerProfileRepository,
    private val retrievalServerClient: RetrievalServerClient,
    private val vectorSyncPendingRepository: VectorSyncPendingRepository,
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

    /**
     * Conversation trigger, called after an exchange completes. Persists the
     * pending-work row FIRST (suspend — one small DynamoDB put), so the work
     * survives a process restart, then runs extraction in the background:
     * immediately when the conversation gained enough messages since the last
     * run, otherwise via a deferred in-process flush (the pending row's dueAt
     * is the restart-proof backstop for both).
     */
    suspend fun enqueueConversationExtraction(
        customerId: String,
        conversationId: String,
        /**
         * Assistant message this exchange produced. The extraction outcome is
         * written onto it as learnedFactsJson — the added facts on success,
         * "[]" on every TERMINAL skipped/exhausted path (the marker that stops
         * client polling). Retryable failures write nothing, so a retry inside
         * the client's polling window can still land real facts.
         */
        responseMessageId: String? = null,
    ) {
        try {
            memoryRepository.putPendingExtraction(
                customerId, conversationId,
                dueAt = Instant.now().plusSeconds(PENDING_BACKSTOP_SECONDS),
                responseMessageId = responseMessageId,
            )
        } catch (e: Exception) {
            // Queue write failing must not break the exchange — extraction
            // degrades to the in-process attempt only.
            Metrics.count("memory_pending_write_failure_total")
            logger.warn("Failed to persist pending extraction for $conversationId: ${e.message}")
        }
        appScope.launch {
            runConversationExtraction(customerId, conversationId, responseMessageId, deferred = false)
        }
    }

    /**
     * Startup hook: sweep the pending-extraction queue every
     * [RECONCILER_INTERVAL_SECONDS], re-dispatching due rows — work lost to a
     * restart, retryable failures, and the debounce backstop. Safe on every
     * instance: the conditional window claim prevents double extraction and
     * row deletes are idempotent.
     */
    fun startPendingReconciler() {
        appScope.launch {
            logger.info("Memory-extraction pending reconciler started (every ${RECONCILER_INTERVAL_SECONDS}s)")
            while (true) {
                try {
                    processDuePendingExtractions()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.warn("Pending-extraction sweep failed: ${e.message}")
                }
                delay(RECONCILER_INTERVAL_SECONDS * 1000)
            }
        }
    }

    /** One reconciler sweep; package-visible for tests. */
    internal suspend fun processDuePendingExtractions() {
        val due = memoryRepository.duePendingExtractions(Instant.now(), RECONCILER_BATCH_SIZE)
        if (due.isEmpty()) return
        logger.info("Pending-extraction sweep: ${due.size} due row(s)")
        for (pending in due) {
            // Bump attempts and push dueAt out BEFORE running, so a crash during
            // this attempt re-dispatches later instead of hot-looping.
            val attempts = memoryRepository.startPendingAttempt(
                pending.customerId, pending.conversationId, RETRY_DELAY_SECONDS
            ) ?: continue // row vanished — a concurrent run completed it
            if (attempts > MAX_PENDING_ATTEMPTS) {
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to "attempts_exhausted", "source" to SOURCE_CONVERSATION
                )
                logger.warn(
                    "Giving up on extraction for conversation {} after {} attempt(s)",
                    pending.conversationId, attempts - 1
                )
                finishConversation(pending.customerId, pending.conversationId, pending.responseMessageId)
                continue
            }
            recoverStaleClaim(pending.customerId, pending.conversationId)
            runConversationExtraction(
                pending.customerId, pending.conversationId, pending.responseMessageId, deferred = true
            )
        }
    }

    /**
     * A claim whose claimedAt is old marks a run that died mid-extraction (the
     * success path finalizes, every failure path rolls back) — release its
     * window so the retry has something to extract.
     */
    private suspend fun recoverStaleClaim(customerId: String, conversationId: String) {
        try {
            val mark = memoryRepository.getExtractionMark(customerId, conversationId) ?: return
            val claimedAt = mark.claimedAt ?: return
            val processed = mark.processed ?: return
            if (Duration.between(claimedAt, Instant.now()).seconds < STALE_CLAIM_SECONDS) return
            val from = mark.claimedFrom?.takeIf { it >= 0 }
            logger.warn(
                "Recovering stale extraction claim on {} (claimed {} at {}) — rolling back to {}",
                conversationId, processed, claimedAt, from
            )
            memoryRepository.rollbackConversationExtractionMark(customerId, conversationId, from, processed)
        } catch (e: Exception) {
            logger.warn("Stale-claim recovery failed for $conversationId: ${e.message}")
        }
    }

    private suspend fun runConversationExtraction(
        customerId: String,
        conversationId: String,
        responseMessageId: String?,
        /** True on the delayed flush / reconciler pass — the message-count threshold no longer applies. */
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
        // Terminal skip: the outcome is settled — stop client polling and
        // drain the pending row so the reconciler never retries it.
        suspend fun terminalSkip(reason: String, detail: String = "") {
            Metrics.count(
                "memory_extraction_skipped_total", 1.0,
                "status" to reason, "source" to SOURCE_CONVERSATION
            )
            logger.info("Memory extraction skipped for conversation {}: {}{}", conversationId, reason, detail)
            markNothingLearned()
            deletePending(customerId, conversationId)
        }
        try {
            logger.info(
                "Memory extraction triggered for conversation {} by customer {} (deferred={})",
                conversationId, customerId, deferred
            )
            if (!memoryService.getMemorySettings(customerId).learnFromChats) {
                terminalSkip("disabled"); return
            }

            val latestMessageId = conversationService.getLatestMessageId(conversationId)
            if (latestMessageId == null) { terminalSkip("empty"); return }
            val thread = conversationService.getMessageThread(conversationId, latestMessageId)
            val processed = memoryRepository.getExtractionMark(customerId, conversationId)?.processed
            val newMessages = thread.size - (processed ?: 0)
            if (newMessages < 1) {
                // Nothing unprocessed (e.g. a parallel-vendor duplicate trigger,
                // or an interim run beat the flush to it) — terminal.
                terminalSkip(if (deferred) "flush_noop" else "debounced", " (0 new messages)"); return
            }
            val threshold = if (processed == null) FIRST_EXTRACTION_MIN_MESSAGES else MESSAGES_PER_EXTRACTION
            if (!deferred && newMessages < threshold) {
                // Below the batching threshold: don't drop the turn — flush it
                // after a short delay instead. No "[]" marker is written here,
                // so the client's learning indicator keeps polling and the
                // flush outcome (which runs well inside the poll timeout)
                // lands on THIS response. The pending row's dueAt backstops a
                // restart during this in-memory wait.
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to "debounced", "source" to SOURCE_CONVERSATION
                )
                logger.info(
                    "Memory extraction debounced for conversation {} ({} new message(s), threshold {}) — flushing in {}ms",
                    conversationId, newMessages, threshold, DEBOUNCE_FLUSH_DELAY_MS
                )
                delay(DEBOUNCE_FLUSH_DELAY_MS)
                runConversationExtraction(customerId, conversationId, responseMessageId, deferred = true)
                return
            }

            // Claim the window before the LLM call so concurrent completions of
            // parallel turns don't double-extract. The loser settles its own
            // message marker but leaves the pending row to the claim's owner.
            if (!memoryRepository.claimConversationExtraction(customerId, conversationId, processed, thread.size)) {
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to "claim_lost", "source" to SOURCE_CONVERSATION
                )
                logger.info("Extraction window for {} claimed by a concurrent run", conversationId)
                markNothingLearned()
                return
            }

            try {
                Metrics.tracked("memory_extraction", "source" to SOURCE_CONVERSATION) {
                    val transcript = thread.takeLast(MAX_TRANSCRIPT_MESSAGES).joinToString("\n") { message ->
                        val speaker = if (message.role == "assistant") "Assistant" else "User"
                        "$speaker: ${message.text.take(MAX_MESSAGE_CHARS)}"
                    }
                    if (logContent) {
                        logger.info("Memory extraction transcript for conversation {}:\n{}", conversationId, transcript)
                    }
                    val added = extract(customerId, transcript, MemorySourceType.CONVERSATION, conversationId)
                    if (responseMessageId != null) {
                        val factsJson = json.encodeToString(added.map { LearnedFactView(it.memoryId, it.text) })
                        conversationService.setMessageLearnedFacts(conversationId, responseMessageId, factsJson)
                    }
                }
                memoryRepository.finalizeConversationExtraction(customerId, conversationId, thread.size)
                deletePending(customerId, conversationId)
            } catch (e: CancellationException) {
                // Shutdown mid-run: the stale-claim recovery releases the
                // window and the pending row re-dispatches after restart.
                throw e
            } catch (e: Exception) {
                // The claimed window is released on EVERY failure so a retry
                // (or the next exchange) can re-extract it.
                memoryRepository.rollbackConversationExtractionMark(
                    customerId, conversationId, processed, thread.size
                )
                when (e) {
                    is RequestAgentUnresolvedException ->
                        // Admin disabled the action — retrying is wrong; the
                        // rolled-back window reopens if it's re-enabled.
                        terminalSkip("unresolved")
                    is NoCustomerAIKeyException ->
                        // No keys stored — nothing a retry can do; the next
                        // exchange re-triggers once keys exist.
                        terminalSkip("no_api_key")
                    else -> {
                        // Retryable (provider failures, transport): keep the
                        // pending row for the reconciler and do NOT settle the
                        // message marker — an in-window retry can still land
                        // real facts on it.
                        logger.warn(
                            "Memory extraction attempt failed for conversation {} — window released for retry: {}",
                            conversationId, e.message
                        )
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.warn("Memory extraction from conversation $conversationId failed: ${e.message}")
        }
    }

    private suspend fun deletePending(customerId: String, conversationId: String) {
        try {
            memoryRepository.deletePendingExtraction(customerId, conversationId)
        } catch (e: Exception) {
            logger.warn("Failed to delete pending-extraction row for $conversationId: ${e.message}")
        }
    }

    /** Terminal settle used by the reconciler's give-up path. */
    private suspend fun finishConversation(customerId: String, conversationId: String, responseMessageId: String?) {
        if (responseMessageId != null) {
            try {
                conversationService.setMessageLearnedFacts(conversationId, responseMessageId, "[]")
            } catch (e: Exception) {
                Metrics.count("memory_learned_facts_write_failure_total")
                logger.warn("Failed to write learned-facts marker for $responseMessageId: ${e.message}")
            }
        }
        deletePending(customerId, conversationId)
    }

    /** Note trigger, called on the final (encode=true) save of an editing session. */
    fun maybeExtractFromNoteAsync(customerId: String, noteKey: String, title: String?, content: String) {
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
                if (!memoryService.getMemorySettings(customerId).learnFromNotes) { skip("disabled"); return@launch }
                val noteText = listOfNotNull(title?.takeIf { it.isNotBlank() && it != "Untitled" }, content)
                    .joinToString("\n").take(MAX_NOTE_CHARS)
                Metrics.tracked("memory_extraction", "source" to SOURCE_NOTE) {
                    extract(customerId, noteText, MemorySourceType.NOTE, noteKey)
                }
            } catch (e: Exception) {
                logger.warn("Memory extraction from note $noteKey failed: ${e.message}")
            }
        }
    }

    /**
     * Runs the published extraction agent with vendor-enforced structured
     * output and customer-key failover — blank/unparseable output advances to
     * the next provider — and returns the memories ADDed by this run. Throws
     * when resolution or every provider fails; callers own the retry story.
     */
    private suspend fun extract(
        customerId: String,
        content: String,
        sourceType: MemorySourceType,
        sourceId: String
    ): List<CustomerMemory> {
        val existing = memoryRepository.getMemories(customerId)
        val existingJson = json.encodeToString(existing.map {
            ExistingMemoryView(it.memoryId, it.kind.name, it.category, it.text)
        })

        val source = sourceType.name.lowercase()
        val agent = agentResolutionService.resolve(RequestType.MEMORY_EXTRACTION, customerId)
        val operations = generationAgentExecutor.executeWithCustomerFailover(
            agent = agent,
            variables = mapOf(
                "existingMemories" to existingJson,
                "sourceType" to source,
                "content" to content
            ),
            customerId = customerId,
            conversationId = "memory-extraction",
            operationName = "memory_extraction",
            responseSchema = OPERATIONS_SCHEMA,
        ) { text -> parseOperationsOrThrow(text, source) }

        if (logContent) {
            logger.info("Memory-extraction operations for {} {}: {}", source, sourceId, operations)
        }
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
                val changed = applyOperation(customerId, op, existingById, sourceType, sourceId, addedMemories)
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
                encodeMemoryVector(customerId, memory)
                addedMemories.add(memory)
                true
            }
        }
        "UPDATE" -> {
            val target = op.memoryId?.let { existingById[it] }
            val text = op.text?.trim()?.take(MAX_MEMORY_CHARS)
            if (target == null || text.isNullOrBlank()) false
            else if (memoryRepository.updateMemoryText(customerId, target.memoryId, text)) {
                // /encode-memory deletes the memory_key's prior vectors before
                // inserting, so the re-encode replaces rather than duplicates.
                encodeMemoryVector(customerId, target.copy(text = text))
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
     * Best-effort push into the vector store for semantic recall, via the
     * retrieval-server's service-to-service /encode-memory — no end-user
     * bearer token involved, so reconciler retries embed exactly like live
     * runs. Memories are tiny and rewritten in place: always the realtime
     * path, never the batch accumulator. A failed embed is recorded in
     * VectorSyncPending — keyword-findable meanwhile — and retried by
     * [VectorRetryService]; a permanent failure (no vector DB or embedding
     * key) is not, since nothing could index the memory.
     */
    private suspend fun encodeMemoryVector(customerId: String, memory: CustomerMemory) {
        try {
            embedMemory(customerId, memory)
        } catch (e: Exception) {
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "encode")
            logger.error("Failed to encode memory ${memory.memoryId} for $customerId", e)
            if ((e as? VectorEncodeException)?.permanent == true) return
            try {
                vectorSyncPendingRepository.markPending(
                    customerId, PendingVectorType.MEMORY, memory.memoryId,
                    retryAt = Instant.now().plusSeconds(VECTOR_FIRST_RETRY_DELAY_SECONDS)
                )
            } catch (markError: Exception) {
                logger.warn("Could not schedule a vector retry for memory ${memory.memoryId}: ${markError.message}")
            }
        }
    }

    /**
     * Re-embeds a memory's current text. Returns false when the memory no
     * longer exists. Throws when the embed fails.
     */
    suspend fun retryMemoryVector(customerId: String, memoryId: String): Boolean {
        val memory = memoryRepository.getMemory(customerId, memoryId) ?: return false
        embedMemory(customerId, memory)
        return true
    }

    private suspend fun embedMemory(customerId: String, memory: CustomerMemory) {
        val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
        // Memories are extracted from conversations, so they follow the
        // conversations-category default.
        val model = prefs?.embeddingModelConversations ?: prefs?.embeddingModel
        retrievalServerClient.encodeMemoryVector(
            customerId = customerId,
            memoryKey = memory.memoryId,
            memoryValue = memory.text,
            title = "[memory] ${memory.category ?: memory.kind.name.lowercase()}",
            createdAt = memory.createdAt,
            modelType = EmbeddingConstants.modelTypeFor(model),
            modelName = model ?: EmbeddingConstants.MODEL_NAME,
        )
    }

    private suspend fun deleteMemoryVector(customerId: String, memoryId: String) {
        try {
            retrievalServerClient.deleteMemoryVectors(customerId, memoryId)
        } catch (e: Exception) {
            Metrics.count("memory_vector_failure_total", 1.0, "operation" to "delete")
            logger.error("Failed to delete vectors for memory $memoryId", e)
        }
    }

    /**
     * Parses the agent's operations JSON, THROWING on blank or unparseable
     * output so the failure advances provider failover instead of masquerading
     * as "nothing learned" (structured output makes this near-impossible, but
     * a provider degrading to raw text must not be a silent success).
     */
    private fun parseOperationsOrThrow(raw: String, source: String): List<MemoryOperation> {
        val cleaned = raw.trim()
            .removePrefix("```json").removePrefix("```")
            .removeSuffix("```").trim()
        if (cleaned.isBlank()) {
            Metrics.count("memory_extraction_unparseable_total", 1.0, "source" to source)
            throw IllegalStateException("blank memory-extraction output")
        }
        return try {
            json.decodeFromString<MemoryOperations>(cleaned).operations
        } catch (e: Exception) {
            Metrics.count("memory_extraction_unparseable_total", 1.0, "source" to source)
            val snippet = if (logContent) " (${cleaned.take(120)}...)" else " (${cleaned.length} chars)"
            throw IllegalStateException("unparseable memory-extraction output$snippet: ${e.message}", e)
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

        /**
         * dueAt offset on the pending row written at enqueue: past the worst
         * normal in-process path (30s debounce flush + extraction + failover),
         * so the reconciler only fires when that path died — a restart or a
         * swallowed failure — not while it is still running.
         */
        private const val PENDING_BACKSTOP_SECONDS = 75L
        /** How far a reconciler-dispatched attempt pushes the next retry out. */
        private const val RETRY_DELAY_SECONDS = 90L
        /** Reconciler attempts before a conversation's pending work is abandoned. */
        private const val MAX_PENDING_ATTEMPTS = 3
        private const val RECONCILER_INTERVAL_SECONDS = 60L
        private const val RECONCILER_BATCH_SIZE = 25
        /** An unfinalized claim older than this is a crashed run — recoverable. */
        private const val STALE_CLAIM_SECONDS = 120L
        /** A failed memory embed's first retry, via [VectorRetryService]. */
        private const val VECTOR_FIRST_RETRY_DELAY_SECONDS = 60L

        /**
         * Vendor-enforced schema for the extraction output (same mechanism as
         * InstructionService.PERSONA_SCHEMA): the model cannot emit free-form
         * prose, so "unparseable" shrinks to providers that degrade to raw
         * text — which failover then skips past.
         */
        internal val OPERATIONS_SCHEMA: JsonObject = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("operations") {
                    put("type", "array")
                    putJsonObject("items") {
                        put("type", "object")
                        putJsonObject("properties") {
                            putJsonObject("op") {
                                put("type", "string")
                                putJsonArray("enum") { add("ADD"); add("UPDATE"); add("DELETE") }
                            }
                            putJsonObject("text") { put("type", "string") }
                            putJsonObject("kind") {
                                put("type", "string")
                                putJsonArray("enum") { add("CORE"); add("EPISODIC") }
                            }
                            putJsonObject("category") { put("type", "string") }
                            putJsonObject("memoryId") { put("type", "string") }
                        }
                        putJsonArray("required") { add("op") }
                    }
                }
            }
            putJsonArray("required") { add("operations") }
        }
    }
}
