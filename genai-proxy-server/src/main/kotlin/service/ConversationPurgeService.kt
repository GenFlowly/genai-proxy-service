package com.genflowly.service

import com.genflowly.observability.Metrics
import com.genflowly.providers.EncodingPurgeClient
import com.genflowly.providers.RunDataClient
import com.genflowly.providers.RunsClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerDataPurgeRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.RetentionTables
import java.time.Instant
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.s3.model.NoSuchKeyException

/** What one attempt of a purge job concluded (a failure is thrown instead). */
sealed class PurgeOutcome {
    object Done : PurgeOutcome()

    /**
     * Waiting on something that ends by itself: a durable run still
     * generating ([pendingRun]), or the conversation purges an account job
     * enqueued. Not a failure; the job is due again a few minutes later.
     */
    data class Reschedule(val reason: String, val pendingRun: Boolean = false) : PurgeOutcome()
}

/** A purge step failed; the job backs off and retries. [step] labels purge_errors_total. */
class PurgeStepException(val step: String, message: String) : Exception(message)

/**
 * Hook for archive and unshare (plan 3.9 step 8): a conversation whose owner
 * was deleted is purged once its last share row is gone.
 */
fun interface OrphanedConversationPurge {
    suspend fun enqueueIfOrphaned(conversationId: String, ownerCustomerId: String): Boolean
}

/**
 * The conversation purge (plan 3.9): deletes everything a conversation's rows
 * link to and then the rows. It runs as a PurgeJobs job keyed by the
 * conversationId, for an unshared conversation of a deleted customer or an
 * orphaned kept one. Each step is idempotent and S3/Postgres go before the
 * rows, so an attempt that dies anywhere leaves the links a re-run needs:
 *
 * 1. (lease taken by the worker) stamp purgeStartedAt on the Conversation row,
 *    so the message-write guard refuses late writes;
 * 2. pendingRuns: record each run id on the job; finished or unknown runs
 *    leave the set, a live one is cancelled and the purge reschedules
 *    without deleting anything;
 * 3. read every message's file references (paginated, projected);
 * 4. delete the exact keys (s3Key, sourceKey or legacy .source.md,
 *    tool-result images) plus the listed `<s3Key>.derived/` objects and the
 *    turns' agent-fs scratch, every key checked against the retention
 *    pattern - keys under a recipient's prefix included, but never a key
 *    another conversation keeps;
 * 5. delete each run's Postgres data (DELETE /runs/{id}/data);
 * 6. delete the exchange vectors of every participant;
 * 7. delete the Message rows (verified by re-reading), then the share,
 *    memory META and InstructionUsageSeen rows, and the Conversation row last.
 */
class ConversationPurgeService(
    private val conversationRepository: ConversationRepository,
    private val purgeRepository: CustomerDataPurgeRepository,
    private val purgeJobRepository: PurgeJobRepository,
    private val s3Provider: S3Provider,
    private val runDataClient: RunDataClient,
    private val runsClient: RunsClient,
    private val encodingPurgeClient: EncodingPurgeClient,
    private val clock: () -> Instant = Instant::now
) : OrphanedConversationPurge {
    private val logger = LoggerFactory.getLogger(ConversationPurgeService::class.java)

    suspend fun purge(job: PurgeJob): PurgeOutcome {
        val conversationId = job.conversationId ?: job.jobKey
        val owner = job.customerId

        // 1. From here on no message may be added
        val rowExists = purgeRepository.markConversationPurgeStarted(owner, conversationId, clock())

        // 2. Durable runs still generating into the conversation
        val seenRunIds = mutableSetOf<String>()
        if (rowExists) {
            val pending = conversationRepository.getPendingRuns(owner, conversationId)
            if (pending.isNotEmpty()) {
                seenRunIds += pending.map { it.runId }
                // A turn that is never persisted has no Message row: this is its only record
                purgeJobRepository.addToSet(job.jobKey, RUN_IDS, seenRunIds)
                var live = 0
                for (entry in pending) {
                    when (runDataClient.runState(entry.runId)) {
                        RunDataClient.RunState.TERMINAL, RunDataClient.RunState.UNKNOWN ->
                            conversationRepository.removePendingRun(owner, conversationId, entry)
                        RunDataClient.RunState.ACTIVE -> {
                            runsClient.cancelRun(entry.runId)
                            live++
                        }
                    }
                }
                if (live > 0) {
                    logger.info("Conversation purge {} waits for {} cancelled run(s) to end", conversationId, live)
                    return PurgeOutcome.Reschedule("pending run", pendingRun = true)
                }
            }
        }

        // 3. Every message, every page
        val messages = conversationRepository.getMessageFileRefs(conversationId)

        // 4. S3
        val keys = keysToDelete(conversationId, messages)
        val stillFailing = s3Provider.deleteObjects(keys)
        if (stillFailing.isNotEmpty()) {
            throw PurgeStepException("s3", "${stillFailing.size} object(s) of conversation $conversationId could not be deleted")
        }
        if (keys.isNotEmpty()) {
            Metrics.count("purge_objects_deleted_total", keys.size.toDouble(), "operation" to "conversation")
        }

        // 5. Postgres run data
        val runIds = messages.mapNotNull { it.runId }.toSet() + job.runIds + seenRunIds
        for (runId in runIds) {
            try {
                runDataClient.deleteRunData(runId)
            } catch (e: IllegalArgumentException) {
                logger.warn("Skipping a malformed run id on conversation {}", conversationId)
            }
        }

        // 6. Exchange vectors, in every participant's conversation collections
        val participants = (messages.mapNotNull { it.customerId } + owner).toSet()
        if (encodingPurgeClient.isConfigured) {
            for (participant in participants) encodingPurgeClient.deleteConversationVectors(participant, conversationId)
        } else {
            warn(job, "vector_purge_skipped: the encoding-server purge is not configured")
        }

        // 7. Rows, the Conversation row last
        purgeRepository.deleteMessages(conversationId, messages.map { it.messageId })
        if (purgeRepository.hasMessages(conversationId)) {
            throw PurgeStepException("dynamodb", "Message rows of conversation $conversationId remain")
        }
        purgeRepository.deleteAllConversationShares(conversationId)
        for (participant in participants) {
            purgeRepository.deleteMemoryConversationMeta(participant, conversationId)
            purgeRepository.deleteInstructionUsageSeen(participant, conversationId)
        }
        if (rowExists) purgeRepository.deleteConversationRow(owner, conversationId)
        logger.info(
            "Purged conversation {}: {} message(s), {} object(s), {} run(s)",
            conversationId, messages.size, keys.size, runIds.size
        )
        return PurgeOutcome.Done
    }

    /**
     * Enqueues the purge of a kept conversation whose owner was deleted once
     * no share row (PUBLIC included) is left: nobody can open it any more.
     * A no-op for a conversation whose owner still exists - archive stays a
     * restorable soft delete.
     */
    override suspend fun enqueueIfOrphaned(conversationId: String, ownerCustomerId: String): Boolean {
        if (purgeJobRepository.get(RetentionTables.accountJobKey(ownerCustomerId)) == null) return false
        if (purgeRepository.conversationShareRecipients(conversationId).isNotEmpty()) return false
        val created = purgeJobRepository.createIfAbsent(
            PurgeJob(
                jobKey = conversationId,
                type = PurgeJobType.CONVERSATION,
                customerId = ownerCustomerId,
                conversationId = conversationId,
                parentKey = RetentionTables.accountJobKey(ownerCustomerId)
            )
        )
        if (created) logger.info("Enqueued the purge of orphaned conversation {} of a deleted customer", conversationId)
        return created
    }

    private suspend fun keysToDelete(conversationId: String, messages: List<MessageFileRefs>): Set<String> {
        val candidates = linkedSetOf<String>()
        val primaries = linkedSetOf<String>()
        val scratchPrefixes = linkedSetOf<String>()
        for (message in messages) {
            val keys = RetentionKeys.messageKeys(message.role, message.attachments, message.toolResultsJson) { attachmentId ->
                logger.warn("Skipping a malformed key on purge: attachmentId={}", attachmentId)
                Metrics.count("retention_malformed_key_total", 1.0, "operation" to "purge")
            }
            candidates += keys.all
            message.attachments.map { it.s3Key }.filterTo(primaries) { RetentionKeys.isRetentionKey(it) }
            val namespace = message.fsNamespace
            val author = message.customerId
            if (namespace != null && author != null && FS_NAMESPACE.matches(namespace)) {
                RetentionKeys.scratchPrefix(author, namespace)
                    .takeIf { RetentionKeys.isRetentionKey(it) }
                    ?.let { scratchPrefixes += it }
            }
        }

        // A key another conversation keeps is that conversation's (this row predates the claim)
        val states = keyStates(conversationId, candidates)
        val owned = states.filterValues { it == KeyState.OWNED }.keys
        // Sidecars too when their primary is already gone (an earlier, partial attempt)
        val prefixes = primaries.filter { states[it] != KeyState.KEPT_ELSEWHERE }.map { RetentionKeys.derivedPrefix(it) } +
            scratchPrefixes
        val listed = prefixes.flatMap { s3Provider.listKeys(it) }
        return (owned + listed).filter { RetentionKeys.isRetentionKey(it) }.toSet()
    }

    private enum class KeyState { OWNED, MISSING, KEPT_ELSEWHERE }

    /** Whether each key exists and is this conversation's to delete (not kept by another one). */
    private suspend fun keyStates(conversationId: String, keys: Collection<String>): Map<String, KeyState> {
        val semaphore = Semaphore(TAG_READ_CONCURRENCY)
        return coroutineScope {
            keys.map { key ->
                async {
                    semaphore.withPermit {
                        val tags = try {
                            s3Provider.getObjectTagging(key)
                        } catch (e: NoSuchKeyException) {
                            return@withPermit key to KeyState.MISSING
                        }
                        val conv = tags[RetentionKeys.CONVERSATION_TAG]
                        val keptElsewhere = tags[RetentionKeys.RETENTION_TAG] == RetentionKeys.RETENTION_KEPT &&
                            !conv.isNullOrBlank() && conv != conversationId
                        if (keptElsewhere) {
                            logger.warn("Purge of {} leaves an object another conversation keeps", conversationId)
                            key to KeyState.KEPT_ELSEWHERE
                        } else key to KeyState.OWNED
                    }
                }
            }.awaitAll().toMap()
        }
    }

    private suspend fun warn(job: PurgeJob, warning: String) {
        logger.warn("Purge job {}: {}", job.jobKey, warning)
        runCatching { purgeJobRepository.addWarning(job.jobKey, warning) }
    }

    companion object {
        const val RUN_IDS = "runIds"
        private const val TAG_READ_CONCURRENCY = 8
        /** The scratch namespace format retrieval-server accepts (plan 1.16). */
        private val FS_NAMESPACE = Regex("^[A-Za-z0-9-]{8,64}$")
    }
}
