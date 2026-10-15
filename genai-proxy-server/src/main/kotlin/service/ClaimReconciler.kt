package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.observability.Metrics
import com.genflowly.repository.ConversationRepository
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Finishes kept-object claims (1.16) that failed at write time. Every
 * [INTERVAL] it reads the oldest messages marked claimPending through the
 * sparse claimPending GSI, re-runs their claim, stores any ref the claim
 * rewrote and clears the flag.
 *
 * A pending claim leaves its objects tagged pending, so the `pending`
 * lifecycle rule (N_pending = 7 days) would expire them while linked: the
 * reconciler's lag must stay well under that. When the oldest pending claim
 * is older than [OVERDUE_AFTER] it logs an error and counts
 * `retention_claim_overdue_total`, which the dashboards alert on.
 */
class ClaimReconciler(
    private val conversationRepository: ConversationRepository,
    private val objectClaimService: ObjectClaimService,
    private val appScope: AppScope,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(ClaimReconciler::class.java)

    data class SweepResult(val examined: Int, val claimed: Int, val stillPending: Int, val overdue: Boolean)

    fun start() {
        appScope.launch {
            delay(INITIAL_DELAY.toMillis())
            logger.info("Kept-object claim reconciler started (every {} min)", INTERVAL.toMinutes())
            while (true) {
                try {
                    sweep()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.warn("Kept-object claim sweep failed: {}", e.message)
                    Metrics.count("retention_claim_reconcile_total", 1.0, "status" to "error")
                }
                delay(INTERVAL.toMillis())
            }
        }
    }

    /** One sweep over at most [BATCH_SIZE] pending claims, oldest first. */
    suspend fun sweep(): SweepResult {
        val pending = conversationRepository.getClaimPendingMessageKeys(BATCH_SIZE)
        if (pending.isEmpty()) return SweepResult(0, 0, 0, overdue = false)

        val oldest = pending.mapNotNull { (_, createdAt) ->
            createdAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        }.minOrNull()
        val overdue = oldest != null && Duration.between(oldest, clock()) > OVERDUE_AFTER
        if (overdue) {
            Metrics.count("retention_claim_overdue_total")
            logger.error(
                "Oldest pending kept-object claim was written at {} (over {} days ago): " +
                    "its objects expire under the pending lifecycle rule unless the claim completes",
                oldest, OVERDUE_AFTER.toDays()
            )
        }

        var claimed = 0
        var stillPending = 0
        for ((key, _) in pending) {
            try {
                val refs = conversationRepository.getMessageFileRefs(key.conversationId, key.messageId) ?: continue
                if (!refs.claimPending) continue
                val outcome = objectClaimService.claim(
                    key.conversationId, key.messageId, refs.role, refs.attachments, refs.toolResultsJson
                )
                val attachmentsChanged = outcome.attachments != refs.attachments
                val toolResultsChanged = outcome.toolResultsJson != refs.toolResultsJson
                val stored = conversationRepository.updateMessageRetention(
                    conversationId = key.conversationId,
                    messageId = key.messageId,
                    attachments = outcome.attachments.takeIf { attachmentsChanged },
                    toolResultsJson = outcome.toolResultsJson.takeIf { toolResultsChanged },
                    clearClaimPending = outcome.complete
                )
                when {
                    // The row was deleted meanwhile (e.g. purged): nothing links what we just claimed
                    !stored -> objectClaimService.releaseToPending(outcome.newlyClaimed)
                    outcome.complete -> claimed++
                    else -> stillPending++
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stillPending++
                logger.warn(
                    "Pending kept-object claim of message {} failed again: {}",
                    key.messageId, e.javaClass.simpleName
                )
            }
        }
        if (claimed > 0) Metrics.count("retention_claim_reconcile_total", claimed.toDouble(), "status" to "ok")
        if (stillPending > 0) {
            Metrics.count("retention_claim_reconcile_total", stillPending.toDouble(), "status" to "pending")
        }
        logger.info("Kept-object claim sweep: {} examined, {} claimed, {} still pending", pending.size, claimed, stillPending)
        return SweepResult(pending.size, claimed, stillPending, overdue)
    }

    companion object {
        val INTERVAL: Duration = Duration.ofMinutes(5)
        val INITIAL_DELAY: Duration = Duration.ofMinutes(1)
        /** Alert threshold: well under the 7-day `pending` expiry. */
        val OVERDUE_AFTER: Duration = Duration.ofDays(3)
        const val BATCH_SIZE = 100
    }
}
