package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.observability.Metrics
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

sealed interface PurgeOutcome {
    data object Done : PurgeOutcome
    data class WaitUntil(val at: Instant) : PurgeOutcome
}

/** Runs one attempt of a job from its recorded stage, throwing on failure. */
fun interface PurgeJobHandler {
    suspend fun run(job: PurgeJob): PurgeOutcome
}

/**
 * One attempt of a deletion job and what follows it: completion, a scheduled
 * re-run, or an error recorded with backoff.
 */
class PurgeJobRunner(
    private val purgeJobs: PurgeJobRepository,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(PurgeJobRunner::class.java)

    suspend fun execute(job: PurgeJob, handler: PurgeJobHandler) {
        val type = job.type.name.lowercase()
        try {
            when (val outcome = handler.run(job)) {
                PurgeOutcome.Done -> {
                    purgeJobs.complete(job, clock())
                    Metrics.count("purge_job_total", 1.0, "type" to type, "status" to "done")
                    logger.info("Deletion job {} finished", job.jobKey)
                }
                is PurgeOutcome.WaitUntil -> purgeJobs.reschedule(job, outcome.at)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val retryAt = clock().plusSeconds(retryDelaySeconds(job.attempts))
            Metrics.count("purge_job_total", 1.0, "type" to type, "status" to "failed")
            logger.error("Deletion job {} failed; retrying at {}", job.jobKey, retryAt, e)
            try {
                purgeJobs.recordError(job, e.message ?: e.javaClass.simpleName)
                purgeJobs.reschedule(job, retryAt)
            } catch (recordFailure: Exception) {
                logger.warn("Could not reschedule deletion job {}: {}", job.jobKey, recordFailure.message)
            }
        }
    }

    companion object {
        /** How long a claimed or running job is hidden from other sweeps. */
        val LEASE: Duration = Duration.ofMinutes(30)

        // Wait before the next attempt: 1 min, 5 min, 30 min, 2 h, then every 6 h.
        private val BACKOFF_SECONDS = listOf(60L, 300L, 1800L, 7200L, 21600L)

        fun retryDelaySeconds(attempts: Int): Long = BACKOFF_SECONDS[(attempts - 1).coerceIn(0, BACKOFF_SECONDS.lastIndex)]
    }
}

/**
 * Every [SWEEP_INTERVAL], claims the due jobs of every type and runs each
 * with its handler: deletions a restart or failure interrupted, retries, and
 * final sweeps. Safe on every instance: the claim is conditional.
 */
class PurgeJobWorker(
    private val purgeJobs: PurgeJobRepository,
    private val runner: PurgeJobRunner,
    private val handlers: Map<PurgeJobType, PurgeJobHandler>,
    private val appScope: AppScope,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(PurgeJobWorker::class.java)

    fun start() {
        appScope.launch {
            logger.info("Deletion job sweep started (every ${SWEEP_INTERVAL.seconds}s)")
            while (true) {
                try {
                    processDueJobs()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.warn("Deletion job sweep failed: ${e.message}")
                }
                delay(SWEEP_INTERVAL.toMillis())
            }
        }
    }

    /** One sweep; package-visible for tests. */
    internal suspend fun processDueJobs() {
        for (due in purgeJobs.dueJobs(clock(), BATCH_SIZE)) {
            val handler = handlers[due.type] ?: continue
            val job = purgeJobs.claim(due, clock().plus(PurgeJobRunner.LEASE)) ?: continue
            runner.execute(job, handler)
        }
    }

    private companion object {
        val SWEEP_INTERVAL: Duration = Duration.ofSeconds(60)
        const val BATCH_SIZE = 25
    }
}
