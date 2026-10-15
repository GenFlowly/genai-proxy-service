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

/**
 * Drains the PurgeJobs queue (plan 3.9): every [POLL_INTERVAL] it reads the
 * due jobs through the sparse pending index, takes each one's lease with a
 * conditional update, and runs it - an account deletion or a conversation
 * purge. A job that waits on a pending run or on its conversation purges is
 * rescheduled in 5 minutes (after [MAX_PENDING_RUN_RESCHEDULES] waits for
 * runs, each further wait counts as a failed attempt); a failed attempt backs
 * off exponentially, and from [ALERT_AFTER_ATTEMPTS] failed attempts on every
 * failure logs an error and counts purge_jobs_total{status="stuck"}.
 *
 * Metrics: purge_jobs_total{operation=account|conversation,
 * status=requested|done|rescheduled|error|stuck}, purge_errors_total{operation=step},
 * purge_objects_deleted_total{operation} (emitted by the jobs).
 */
class PurgeJobWorker(
    private val purgeJobRepository: PurgeJobRepository,
    private val accountDeletionService: AccountDeletionService,
    private val conversationPurgeService: ConversationPurgeService,
    private val appScope: AppScope,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(PurgeJobWorker::class.java)

    fun start() {
        appScope.launch {
            delay(INITIAL_DELAY.toMillis())
            logger.info("Purge job worker started (every {} s)", POLL_INTERVAL.seconds)
            while (true) {
                try {
                    pollOnce()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.warn("Purge job poll failed: {}", e.message)
                }
                delay(POLL_INTERVAL.toMillis())
            }
        }
    }

    /** Runs every due job once; returns how many it ran. */
    suspend fun pollOnce(): Int {
        var ran = 0
        for (job in purgeJobRepository.dueJobs(clock(), BATCH_SIZE)) {
            if (runJob(job)) ran++
        }
        return ran
    }

    /** One attempt of [job] under its lease; false when another worker holds it. */
    suspend fun runJob(job: PurgeJob): Boolean {
        val now = clock()
        if (!purgeJobRepository.tryLease(job.jobKey, now, now.plus(LEASE))) return false
        val operation = job.type.name.lowercase()
        try {
            val outcome = when (job.type) {
                PurgeJobType.ACCOUNT -> accountDeletionService.run(job)
                PurgeJobType.CONVERSATION -> conversationPurgeService.purge(job)
            }
            when (outcome) {
                PurgeOutcome.Done -> {
                    purgeJobRepository.complete(job.jobKey)
                    Metrics.count("purge_jobs_total", 1.0, "operation" to operation, "status" to "done")
                    logger.info("Purge job {} done", job.jobKey)
                }
                is PurgeOutcome.Reschedule -> {
                    val failed = outcome.pendingRun && job.reschedules >= MAX_PENDING_RUN_RESCHEDULES
                    purgeJobRepository.reschedule(
                        job.jobKey, now.plus(RESCHEDULE_DELAY),
                        failed = failed, rescheduled = outcome.pendingRun,
                        error = if (failed) "a durable run is still pending after ${job.reschedules + 1} waits" else null
                    )
                    Metrics.count("purge_jobs_total", 1.0, "operation" to operation, "status" to "rescheduled")
                    if (failed) alertIfStuck(job, job.attempts + 1)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val attempts = job.attempts + 1
            val step = (e as? PurgeStepException)?.step ?: operation
            // Exception text carries ids and status codes, never user content
            val error = "${e.javaClass.simpleName}: ${e.message?.take(300)}"
            runCatching {
                purgeJobRepository.reschedule(job.jobKey, now.plus(backoff(attempts)), failed = true, rescheduled = false, error = error)
            }.onFailure { logger.error("Could not reschedule purge job {}", job.jobKey, it) }
            Metrics.count("purge_jobs_total", 1.0, "operation" to operation, "status" to "error")
            Metrics.count("purge_errors_total", 1.0, "operation" to step)
            logger.warn("Purge job {} attempt {} failed at {}: {}", job.jobKey, attempts, step, error)
            alertIfStuck(job, attempts)
        }
        return true
    }

    private fun alertIfStuck(job: PurgeJob, attempts: Int) {
        if (attempts < ALERT_AFTER_ATTEMPTS) return
        Metrics.count("purge_jobs_total", 1.0, "operation" to job.type.name.lowercase(), "status" to "stuck")
        logger.error("Purge job {} has failed {} times and keeps retrying; it needs attention", job.jobKey, attempts)
    }

    companion object {
        val POLL_INTERVAL: Duration = Duration.ofMinutes(1)
        val INITIAL_DELAY: Duration = Duration.ofSeconds(30)
        /** Longer than any single account-job step; each step extends it. */
        val LEASE: Duration = Duration.ofMinutes(15)
        val RESCHEDULE_DELAY: Duration = Duration.ofMinutes(5)
        const val MAX_PENDING_RUN_RESCHEDULES = 6
        const val ALERT_AFTER_ATTEMPTS = 10
        const val BATCH_SIZE = 10
        private val MAX_BACKOFF: Duration = Duration.ofHours(6)

        /** 1, 2, 4, ... minutes after the 1st, 2nd, 3rd failure; at most 6 hours. */
        fun backoff(attempts: Int): Duration {
            val minutes = 1L shl (attempts - 1).coerceIn(0, 20)
            return Duration.ofMinutes(minutes).coerceAtMost(MAX_BACKOFF)
        }
    }
}
