package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.RequestType
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.LearnedFactView
import com.genflowly.models.api.MemoryRun
import com.genflowly.models.api.MemoryRunOperation
import com.genflowly.models.api.MemoryRunResponse
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.observability.Metrics
import com.genflowly.repository.MemoryChangeCause
import com.genflowly.repository.MemoryRepository
import java.time.Duration
import java.time.Instant
import java.util.UUID
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
    val memoryId: String? = null,
    val reason: String? = null,
    val messageIndex: Int? = null
)

@Serializable
private data class ExistingMemoryView(
    val memoryId: String,
    val kind: String,
    val appliesIn: String,
    val category: String?,
    val text: String
)

/** What one extraction run reads from: the content, where it came from, and where its memories go. */
private data class ExtractionSource(
    val type: MemorySourceType,
    val sourceId: String,
    /** The conversation's project (its owner's), or null for Profile. */
    val projectId: String?,
    /** Transcript line number to message id, for attributing each change. */
    val messageIds: Map<Int, String> = emptyMap(),
    /** The user message the turn started from, for the run record. */
    val turnMessageId: String? = null,
    /** The turn's responses the transcript includes, for the run record. */
    val responsesRead: List<MemoryRunResponse> = emptyList(),
)

/** What a run produced: the memories it added and the record describing it. */
private data class ExtractionOutcome(val added: List<CustomerMemory>, val runId: String)

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
 *
 * A conversation in a project learns into that project and sees only Profile
 * memories and that project's; other projects' memories stay out of reach.
 * Every ADD and UPDATE is logged with the conversation, the message that
 * caused it and the agent's reason.
 */
class MemoryExtractionService(
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val memoryRepository: MemoryRepository,
    private val memoryService: MemoryService,
    private val conversationService: ConversationService,
    private val memoryVectorService: MemoryVectorService,
    private val appScope: AppScope,
    private val costCalculationService: CostCalculationService,
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
        /**
         * The user message the turn started from. With it, memory learns ONCE
         * per turn from every response of the turn; without it (older
         * callers) each response is its own trigger, as before.
         */
        turnMessageId: String? = null,
        /** How many responses the client is generating for the turn, when it said. */
        expectedResponses: Int? = null,
    ) {
        if (turnMessageId != null && responseMessageId != null) {
            enqueueTurnResponse(customerId, conversationId, turnMessageId, responseMessageId, expectedResponses)
            return
        }
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
     * One response of a turn finished. A turn whose outcome is already known
     * (a response that finished after the run) just copies it; otherwise the
     * response joins the turn's pending row and the run starts when the last
     * expected response is in — or after [TURN_SETTLE_DELAY_MS] when the
     * client never said how many to expect.
     */
    private suspend fun enqueueTurnResponse(
        customerId: String,
        conversationId: String,
        turnMessageId: String,
        responseMessageId: String,
        expectedResponses: Int?,
    ) {
        val settled = try {
            conversationService.getTurnResponses(conversationId, turnMessageId)
                .firstOrNull { it.messageId != responseMessageId && it.learnedFactsJson != null }
        } catch (e: Exception) {
            null
        }
        if (settled != null) {
            Metrics.count(
                "memory_extraction_skipped_total", 1.0,
                "status" to "turn_settled", "source" to SOURCE_CONVERSATION
            )
            writeLearnedFacts(conversationId, responseMessageId, settled.learnedFactsJson!!)
            return
        }
        val pending = try {
            memoryRepository.recordTurnResponse(
                customerId, conversationId, turnMessageId, responseMessageId, expectedResponses,
                dueAt = Instant.now().plusSeconds(PENDING_BACKSTOP_SECONDS),
            )
        } catch (e: Exception) {
            Metrics.count("memory_pending_write_failure_total")
            logger.warn("Failed to persist pending extraction for $conversationId: ${e.message}")
            null
        }
        val finished = pending?.responseMessageIds?.size ?: 1
        val expected = pending?.expectedResponses ?: expectedResponses
        val ready = expected != null && finished >= expected
        appScope.launch {
            if (!ready) {
                logger.info(
                    "Memory extraction for {} waits for the turn to settle ({} of {} responses)",
                    conversationId, finished, expected ?: "?"
                )
                delay(TURN_SETTLE_DELAY_MS)
            }
            runConversationExtraction(
                customerId, conversationId, responseMessageId, deferred = !ready, turnMessageId = turnMessageId
            )
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
                finishConversation(pending.customerId, pending.conversationId, pending.responseMessageId, pending.turnMessageId)
                continue
            }
            recoverStaleClaim(pending.customerId, pending.conversationId)
            runConversationExtraction(
                pending.customerId, pending.conversationId, pending.responseMessageId, deferred = true,
                turnMessageId = pending.turnMessageId
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
        /** The turn being learned; null for callers that still trigger per response. */
        turnMessageId: String? = null,
    ) {
        // Nothing learned: every response of the turn gets the marker, except
        // ones a sibling already settled with real facts
        suspend fun markNothingLearned() = settleTurn(conversationId, turnMessageId, responseMessageId, factsJson = null)
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

            // Per turn: the chain up to the turn's user message plus every
            // response of the turn, which count as one message for the
            // threshold. Per response (older callers): the chain from the
            // latest message, as before.
            val turnResponses = if (turnMessageId != null) {
                conversationService.getTurnResponses(conversationId, turnMessageId)
            } else emptyList()
            val threadHead = turnMessageId ?: conversationService.getLatestMessageId(conversationId)
            if (threadHead == null) { terminalSkip("empty"); return }
            val thread = conversationService.getMessageThread(conversationId, threadHead)
            if (thread.isEmpty()) { terminalSkip("empty"); return }
            val messageCount = thread.size + (if (turnResponses.isEmpty()) 0 else 1)
            val processed = memoryRepository.getExtractionMark(customerId, conversationId)?.processed
            val newMessages = messageCount - (processed ?: 0)
            if (newMessages < 1) {
                if (turnMessageId != null) {
                    // Another response of this turn already ran (or is running)
                    // the turn's extraction: its owner settles every response,
                    // so this one only fills in what the owner missed
                    Metrics.count(
                        "memory_extraction_skipped_total", 1.0,
                        "status" to "turn_owned", "source" to SOURCE_CONVERSATION
                    )
                    settleAfterOwner(customerId, conversationId, turnMessageId, responseMessageId)
                    return
                }
                // Nothing unprocessed (an interim run beat the flush to it) — terminal.
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
                runConversationExtraction(
                    customerId, conversationId, responseMessageId, deferred = true, turnMessageId = turnMessageId
                )
                return
            }

            // Claim the window before the LLM call so concurrent completions of
            // parallel turns don't double-extract. The loser settles its own
            // message marker but leaves the pending row to the claim's owner.
            if (!memoryRepository.claimConversationExtraction(customerId, conversationId, processed, messageCount)) {
                Metrics.count(
                    "memory_extraction_skipped_total", 1.0,
                    "status" to "claim_lost", "source" to SOURCE_CONVERSATION
                )
                logger.info("Extraction window for {} claimed by a concurrent run", conversationId)
                // The owner settles the whole turn; a per-response caller
                // settles only itself
                if (turnMessageId == null) markNothingLearned()
                return
            }

            try {
                Metrics.tracked("memory_extraction", "source" to SOURCE_CONVERSATION) {
                    val recent = thread.takeLast(MAX_TRANSCRIPT_MESSAGES)
                    val lines = recent.map { message ->
                        val speaker = if (message.role == "assistant") "Assistant" else "User"
                        message to speaker
                    } + turnResponses.map { response ->
                        response to "Assistant (${response.aiConfig.firstOrNull()?.aiVendor?.name ?: "assistant"})"
                    }
                    val transcript = lines.withIndex().joinToString("\n") { (i, line) ->
                        "[${i + 1}] ${line.second}: ${line.first.text.take(MAX_MESSAGE_CHARS)}"
                    }
                    if (logContent) {
                        logger.info("Memory extraction transcript for conversation {}:\n{}", conversationId, transcript)
                    }
                    val source = ExtractionSource(
                        type = MemorySourceType.CONVERSATION,
                        sourceId = conversationId,
                        projectId = conversationService.getOwnedConversationProjectId(conversationId, customerId),
                        messageIds = lines.withIndex().associate { (i, line) -> i + 1 to line.first.messageId },
                        turnMessageId = turnMessageId,
                        responsesRead = turnResponses.map { response ->
                            val config = response.aiConfig.firstOrNull()
                            MemoryRunResponse(response.messageId, config?.aiVendor?.name ?: "", config?.model)
                        },
                    )
                    val outcome = extract(customerId, transcript, source)
                    val factsJson = json.encodeToString(outcome.added.map {
                        LearnedFactView(it.memoryId, it.text, kind = it.kind.name, runId = outcome.runId)
                    })
                    settleTurn(conversationId, turnMessageId, responseMessageId, factsJson)
                }
                memoryRepository.finalizeConversationExtraction(customerId, conversationId, messageCount)
                deletePending(customerId, conversationId)
            } catch (e: CancellationException) {
                // Shutdown mid-run: the stale-claim recovery releases the
                // window and the pending row re-dispatches after restart.
                throw e
            } catch (e: Exception) {
                // The claimed window is released on EVERY failure so a retry
                // (or the next exchange) can re-extract it.
                memoryRepository.rollbackConversationExtractionMark(
                    customerId, conversationId, processed, messageCount
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
    private suspend fun finishConversation(
        customerId: String,
        conversationId: String,
        responseMessageId: String?,
        turnMessageId: String? = null,
    ) {
        settleTurn(conversationId, turnMessageId, responseMessageId, factsJson = null)
        deletePending(customerId, conversationId)
    }

    /**
     * Writes the turn's outcome onto every response of the turn (and the
     * triggering response, for callers without a turn). [factsJson] null
     * means nothing was learned: responses a sibling already settled with
     * real facts keep them, the rest get "[]" — or the sibling's facts, so a
     * response that finished after the run shows the same list.
     */
    private suspend fun settleTurn(
        conversationId: String,
        turnMessageId: String?,
        responseMessageId: String?,
        factsJson: String?,
    ) {
        val responses = if (turnMessageId != null) {
            try {
                conversationService.getTurnResponses(conversationId, turnMessageId)
            } catch (e: Exception) {
                logger.warn("Could not list the responses of turn $turnMessageId: ${e.message}")
                emptyList()
            }
        } else emptyList()
        val targets = (responses.map { it.messageId } + listOfNotNull(responseMessageId)).distinct()
        val known = factsJson
            ?: responses.firstNotNullOfOrNull { it.learnedFactsJson?.takeIf { facts -> facts != "[]" } }
        for (messageId in targets) {
            val existing = responses.firstOrNull { it.messageId == messageId }?.learnedFactsJson
            if (factsJson == null && existing != null) continue
            writeLearnedFacts(conversationId, messageId, known ?: "[]")
        }
    }

    /**
     * A response of a turn whose extraction another response owns: wait while
     * the owner's claim is in flight, then copy the turn's outcome onto this
     * response if the owner's settle missed it (it finished after the owner
     * listed the turn).
     */
    private suspend fun settleAfterOwner(
        customerId: String,
        conversationId: String,
        turnMessageId: String,
        responseMessageId: String?,
    ) {
        repeat(OWNER_WAIT_CHECKS) {
            val inFlight = try {
                memoryRepository.getExtractionMark(customerId, conversationId)?.claimedAt != null
            } catch (e: Exception) {
                false
            }
            if (!inFlight) return@repeat
            delay(OWNER_WAIT_INTERVAL_MS)
        }
        settleTurn(conversationId, turnMessageId, responseMessageId, factsJson = null)
    }

    private suspend fun writeLearnedFacts(conversationId: String, messageId: String, factsJson: String) {
        try {
            conversationService.setMessageLearnedFacts(conversationId, messageId, factsJson)
        } catch (e: Exception) {
            Metrics.count("memory_learned_facts_write_failure_total")
            logger.warn("Failed to write learned-facts marker for $messageId: ${e.message}")
        }
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
                    extract(customerId, noteText, ExtractionSource(MemorySourceType.NOTE, noteKey, projectId = null)).added
                }
            } catch (e: Exception) {
                logger.warn("Memory extraction from note $noteKey failed: ${e.message}")
            }
        }
    }

    /**
     * Runs the published extraction agent with vendor-enforced structured
     * output and customer-key failover — blank/unparseable output advances to
     * the next provider — applies its operations, and records the run (what
     * it read, what it decided and why, which provider answered, what it
     * cost) for the "how it was inferred" page. Returns the memories ADDed.
     * Throws when resolution or every provider fails; callers own the retry
     * story, and no run is recorded.
     */
    private suspend fun extract(
        customerId: String,
        content: String,
        extractionSource: ExtractionSource,
    ): ExtractionOutcome {
        val runId = UUID.randomUUID().toString()
        val startedAt = Instant.now()
        val projectId = extractionSource.projectId
        val sourceId = extractionSource.sourceId
        // Profile memories plus this project's: other projects' are siloed and
        // must neither be shown to the agent nor be editable from here.
        val existing = memoryRepository.getMemories(customerId).mapNotNull { memory ->
            val here = memory.placements.firstOrNull { it.projectId == null }
                ?: projectId?.let { id -> memory.placements.firstOrNull { it.projectId == id } }
                ?: return@mapNotNull null
            memory to here
        }
        val existingJson = json.encodeToString(existing.map { (memory, here) ->
            ExistingMemoryView(
                memory.memoryId, here.kind.name,
                appliesIn = if (here.projectId == null) "profile" else "this project",
                memory.category, memory.text
            )
        })

        val source = extractionSource.type.name.lowercase()
        val agent = agentResolutionService.resolve(RequestType.MEMORY_EXTRACTION, customerId)
        val answer = generationAgentExecutor.executeWithCustomerFailoverDetailed(
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
        val operations = answer.value

        if (logContent) {
            logger.info("Memory-extraction operations for {} {}: {}", source, sourceId, operations)
        }

        val existingById = existing.associate { (memory, _) -> memory.memoryId to memory }
        val addedMemories = mutableListOf<CustomerMemory>()
        val recorded = mutableListOf<MemoryRunOperation>()
        var applied = 0
        operations.forEach { op ->
            val opName = op.op.lowercase().takeIf { it in KNOWN_OPERATIONS } ?: "unknown"
            val before = addedMemories.size
            val outcome = try {
                val changed = applyOperation(customerId, op, existingById, extractionSource, runId, addedMemories)
                if (changed) applied++
                Metrics.count(
                    "memory_operation_total", 1.0,
                    "operation" to opName, "status" to if (changed) "ok" else "noop"
                )
                if (changed) "applied" else "noop"
            } catch (e: Exception) {
                Metrics.count("memory_operation_total", 1.0, "operation" to opName, "status" to "error")
                logger.warn("Failed to apply memory operation ${op.op} for $customerId: ${e.message}")
                "error"
            }
            recorded += MemoryRunOperation(
                op = op.op.uppercase(),
                memoryId = addedMemories.getOrNull(before)?.memoryId ?: op.memoryId,
                text = op.text?.trim()?.let(::fitMemoryText),
                reason = op.reason?.trim()?.take(MAX_REASON_CHARS)?.takeIf { it.isNotEmpty() },
                messageIndex = op.messageIndex,
                outcome = outcome,
            )
        }
        when {
            operations.isEmpty() -> logger.info("Memory extraction returned no operations for {} {}", source, sourceId)
            applied > 0 -> logger.info("Applied $applied memory operation(s) for customer $customerId from $source $sourceId")
            else -> logger.info("No memory operation changed stored state for $source $sourceId (${operations.size} proposed)")
        }

        val cost = try {
            costCalculationService.computeCostUsd(
                answer.vendor, answer.model,
                TokenUsageBreakdown(
                    inputTokens = answer.inputTokens,
                    outputTokens = answer.outputTokens,
                    cacheReadTokens = answer.tokensReadFromCache,
                )
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val run = MemoryRun(
            runId = runId,
            source = source,
            conversationId = sourceId.takeIf { extractionSource.type == MemorySourceType.CONVERSATION },
            projectId = projectId,
            turnMessageId = extractionSource.turnMessageId,
            messageIds = extractionSource.messageIds.toSortedMap().values.toList(),
            responsesRead = extractionSource.responsesRead,
            existingShown = existing.size,
            agentId = agent.graphId,
            vendor = answer.vendor.name,
            model = answer.model,
            startedAt = startedAt.toString(),
            durationMs = Duration.between(startedAt, Instant.now()).toMillis(),
            inputTokens = answer.inputTokens,
            outputTokens = answer.outputTokens,
            costUsd = cost,
            operations = recorded.take(MAX_RUN_OPERATIONS),
            truncated = recorded.size > MAX_RUN_OPERATIONS,
        )
        try {
            memoryRepository.putRun(customerId, run)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The memories stand without their story; the page says so
            Metrics.count("memory_run_write_failure_total")
            logger.warn("Failed to record memory run $runId for $source $sourceId: ${e.message}")
        }
        return ExtractionOutcome(addedMemories, runId)
    }

    /** Returns true when the operation changed stored state. */
    private suspend fun applyOperation(
        customerId: String,
        op: MemoryOperation,
        existingById: Map<String, CustomerMemory>,
        source: ExtractionSource,
        runId: String,
        addedMemories: MutableList<CustomerMemory> = mutableListOf()
    ): Boolean = when (op.op.uppercase()) {
        "ADD" -> {
            val text = op.text?.trim()?.let(::fitMemoryText)
            if (text.isNullOrBlank()) false else {
                val kind = op.kind?.uppercase()
                    ?.let { runCatching { MemoryKind.valueOf(it) }.getOrNull() } ?: MemoryKind.EPISODIC
                val memory = memoryRepository.createMemory(
                    customerId = customerId,
                    text = text,
                    placements = listOf(MemoryPlacement(source.projectId, kind)),
                    category = op.category?.take(50),
                    sourceType = source.type,
                    sourceId = source.sourceId,
                    cause = cause(MemoryChangeType.LEARNED, op, source, runId),
                )
                memoryVectorService.encode(customerId, memory)
                addedMemories.add(memory)
                true
            }
        }
        "UPDATE" -> {
            val target = op.memoryId?.let { existingById[it] }
            val text = op.text?.trim()?.let(::fitMemoryText)
            if (target == null || text.isNullOrBlank() || text == target.text) false
            else if (memoryRepository.updateMemoryText(customerId, target, text, cause(MemoryChangeType.UPDATED, op, source, runId))) {
                // /encode-memory deletes the memory_key's prior vectors before
                // inserting, so the re-encode replaces rather than duplicates.
                memoryVectorService.encode(customerId, target.copy(text = text))
                true
            } else false
        }
        "DELETE" -> {
            val target = op.memoryId?.let { existingById[it] }
            if (target == null) false else {
                // From a project conversation, a memory other projects share
                // only leaves this project; anything else is deleted outright.
                val inThisProject = source.projectId?.takeIf { id -> target.placements.any { it.projectId == id } }
                try {
                    memoryService.deleteMemory(
                        customerId, target.memoryId, inThisProject,
                        cause = cause(MemoryChangeType.REMOVED_FROM_PROJECT, op, source, runId),
                    )
                    true
                } catch (e: MemoryNotFoundException) {
                    false
                } catch (e: MemoryConflictException) {
                    false
                }
            }
        }
        else -> {
            logger.warn("Ignoring unknown memory operation '${op.op}' for $customerId")
            false
        }
    }

    private fun cause(type: MemoryChangeType, op: MemoryOperation, source: ExtractionSource, runId: String) =
        MemoryChangeCause(
            type = type,
            sourceType = source.type,
            conversationId = source.sourceId.takeIf { source.type == MemorySourceType.CONVERSATION },
            messageId = op.messageIndex?.let { source.messageIds[it] },
            noteKey = source.sourceId.takeIf { source.type == MemorySourceType.NOTE },
            reason = op.reason?.trim()?.take(MAX_REASON_CHARS)?.takeIf { it.isNotEmpty() },
            runId = runId,
        )

    /**
     * Re-embeds a memory's current text. Returns false when the memory no
     * longer exists. Throws when the embed fails.
     */
    suspend fun retryMemoryVector(customerId: String, memoryId: String): Boolean =
        memoryVectorService.retry(customerId, memoryId)

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

        /**
         * How long a turn's first finished response waits for the others when
         * the client did not say how many to expect. A vendor that never
         * reports (crash) is covered by the same wait.
         */
        private const val TURN_SETTLE_DELAY_MS = 30_000L
        private const val OWNER_WAIT_CHECKS = 6
        private const val OWNER_WAIT_INTERVAL_MS = 5_000L
        private const val MAX_TRANSCRIPT_MESSAGES = 12
        private const val MAX_MESSAGE_CHARS = 2000
        private const val MIN_NOTE_CHARS = 30
        private const val MAX_NOTE_CHARS = 8000
        internal const val MAX_MEMORY_CHARS = 300
        private const val MAX_RUN_OPERATIONS = 50
        private const val MAX_REASON_CHARS = 300

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
                            putJsonObject("reason") {
                                put("type", "string")
                                put(
                                    "description",
                                    "Why this operation is needed, in one short sentence the user will read " +
                                        "in their memory's change log."
                                )
                            }
                            putJsonObject("messageIndex") {
                                put("type", "integer")
                                put(
                                    "description",
                                    "Number of the transcript line ([n]) that caused this operation, usually the " +
                                        "user's own message. Omit for notes."
                                )
                            }
                        }
                        putJsonArray("required") { add("op") }
                    }
                }
            }
            putJsonArray("required") { add("operations") }
        }
    }
}

/**
 * Fits learned text into [MemoryExtractionService.MAX_MEMORY_CHARS] without
 * cutting a word: at the last sentence end when one falls in the second half
 * (a whole sentence needs no ellipsis), otherwise at the last clause or word
 * break, marked with "…".
 */
internal fun fitMemoryText(text: String, max: Int = MemoryExtractionService.MAX_MEMORY_CHARS): String {
    if (text.length <= max) return text
    val window = text.take(max)
    val sentenceEnd = Regex("[.!?](?=\\s)").findAll(window).lastOrNull()?.range?.last
    if (sentenceEnd != null && sentenceEnd >= max / 2) return window.take(sentenceEnd + 1).trimEnd()
    val room = window.take(max - 1)
    val clause = room.lastIndexOf("; ").takeIf { it >= max / 2 }
    val word = room.lastIndexOf(' ').takeIf { it > 0 }
    val cut = clause ?: word ?: room.length
    return room.take(cut).trimEnd(' ', ',', ';', ':', '-') + "…"
}
