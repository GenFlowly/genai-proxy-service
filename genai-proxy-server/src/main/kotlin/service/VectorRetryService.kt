package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.observability.Metrics
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.PendingVectorItem
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Retries embeds that never reached the vector DB — conversation exchanges
 * whose encoding-server pipeline run failed, and memories whose direct embed
 * failed — from the VectorSyncPending rows scheduled for a retry. Same
 * mechanism as the memory-extraction reconciler: every
 * [SWEEP_INTERVAL_SECONDS] it claims each due row (bumping attempts and
 * pushing dueAt out before running, so a crash re-dispatches later), backs
 * off between attempts and gives up after [MAX_ATTEMPTS]. A row that stops
 * retrying stays in the table, so its record remains keyword-findable.
 * Safe on every instance: the claim is conditional on the dueAt it read.
 */
class VectorRetryService(
    private val vectorSyncPendingRepository: VectorSyncPendingRepository,
    private val conversationIndexingService: ConversationIndexingService,
    private val memoryExtractionService: MemoryExtractionService,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(VectorRetryService::class.java)

    fun start() {
        appScope.launch {
            logger.info("Vector retry sweep started (every ${SWEEP_INTERVAL_SECONDS}s)")
            while (true) {
                try {
                    processDueRetries()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.warn("Vector retry sweep failed: ${e.message}")
                }
                delay(SWEEP_INTERVAL_SECONDS * 1000)
            }
        }
    }

    /** One sweep; package-visible for tests. */
    internal suspend fun processDueRetries() {
        val due = vectorSyncPendingRepository.dueRetries(Instant.now(), BATCH_SIZE)
        if (due.isEmpty()) return
        logger.info("Vector retry sweep: ${due.size} due row(s)")
        for (item in due) {
            val attempt = vectorSyncPendingRepository.startAttempt(item, retryDelaySeconds(item.attempts + 1))
                ?: continue // stored or claimed meanwhile
            retry(item, attempt)
        }
    }

    private suspend fun retry(item: PendingVectorItem, attempt: Int) {
        val label = "${item.type.token} ${item.key}"
        try {
            val exists = when (item.type) {
                PendingVectorType.CONVERSATION -> item.conversationId
                    ?.let { conversationIndexingService.retryExchange(item.customerId, it, item.key) }
                    ?: false
                PendingVectorType.MEMORY -> memoryExtractionService.retryMemoryVector(item.customerId, item.key)
                PendingVectorType.NOTE -> {
                    // Notes are never scheduled; a scheduled one is a bad row.
                    vectorSyncPendingRepository.stopRetrying(item)
                    return
                }
            }
            vectorSyncPendingRepository.clear(item.customerId, item.type, item.key)
            Metrics.count("vector_retry_total", 1.0, "type" to item.type.token, "status" to if (exists) "stored" else "gone")
            logger.info("Vector retry for $label: ${if (exists) "stored" else "record gone"} (attempt $attempt)")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val permanent = (e as? VectorEncodeException)?.permanent == true
            if (permanent || attempt >= MAX_ATTEMPTS) {
                vectorSyncPendingRepository.stopRetrying(item)
                Metrics.count(
                    "vector_retry_total", 1.0,
                    "type" to item.type.token, "status" to if (permanent) "permanent_failure" else "attempts_exhausted"
                )
                logger.warn("Giving up on vector retry for $label after attempt $attempt: ${e.message}")
            } else {
                Metrics.count("vector_retry_total", 1.0, "type" to item.type.token, "status" to "failed")
                logger.warn("Vector retry for $label failed (attempt $attempt): ${e.message}")
            }
        }
    }

    companion object {
        private const val SWEEP_INTERVAL_SECONDS = 60L
        private const val BATCH_SIZE = 25
        const val MAX_ATTEMPTS = 8

        // Wait before the attempt after [attempt]: 1 min, 5 min, 30 min, then 2 h.
        private val BACKOFF_SECONDS = listOf(60L, 300L, 1800L, 7200L)

        fun retryDelaySeconds(attempt: Int): Long = BACKOFF_SECONDS[(attempt - 1).coerceIn(0, BACKOFF_SECONDS.lastIndex)]
    }
}
