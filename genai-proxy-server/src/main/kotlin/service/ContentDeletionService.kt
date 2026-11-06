package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.observability.Metrics
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.PurgeRepository
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Permanent deletion of one conversation or note, everywhere we store it.
 *
 * A request removes what makes the item reachable before it returns, so no
 * listing, link or search can show it again: a conversation's row and every
 * share of it (its public link included), or a note's row. A job in
 * PurgeJobs ([PurgeJobWorker] resumes it after a restart or failure) then
 * deletes the rest in stages:
 *
 * - Conversation: the files its messages reference, then the messages and
 *   the rows about it (vector-DB queue, memory-extraction bookkeeping,
 *   instruction usage), then its vectors.
 * - Note: its batch-mode document, every version, then its vectors.
 *
 * A reply still generating, or an encoding run still in flight, can write
 * after a stage ran, so [FINAL_SWEEP_DELAY] after the request every stage
 * runs once more. Facts learned from the item stay: they are managed in
 * Settings, and other conversations may have taught them too.
 *
 * Files are shared along forks (a fork copies its messages' file
 * references), so a file still used by another conversation in the same fork
 * tree is kept, and checked again by the final sweep.
 */
class ContentDeletionService(
    private val purgeJobs: PurgeJobRepository,
    private val runner: PurgeJobRunner,
    private val purge: PurgeRepository,
    private val s3Provider: S3Provider,
    private val documentsPurger: CustomerDocumentsPurger,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope,
    private val clock: () -> Instant = Instant::now
) : PurgeJobHandler {
    private val logger = LoggerFactory.getLogger(ContentDeletionService::class.java)

    /**
     * Deletes the conversation [conversationId], owned by [customerId], which
     * was forked from [parentId] (null if it wasn't). Returns once nothing can
     * show it; throws if that fails, and the job is retried.
     */
    suspend fun requestConversationDeletion(customerId: String, conversationId: String, parentId: String?) =
        request(PurgeJob(PurgeJobType.CONVERSATION, customerId, conversationId, clock(), parentId = parentId))

    /** Deletes the note [noteKey] of [customerId]. Returns once nothing can show it. */
    suspend fun requestNoteDeletion(customerId: String, noteKey: String) =
        request(PurgeJob(PurgeJobType.NOTE, customerId, noteKey, clock()))

    private suspend fun request(requested: PurgeJob) {
        require(AccountDeletionService.isDeletableCustomerId(requested.customerId)) { "Not a deletable customer id" }
        require(!requested.itemId.isNullOrBlank()) { "Nothing to delete" }
        val created = purgeJobs.createIfAbsent(requested, dueAt = requested.requestedAt.plus(PurgeJobRunner.LEASE))
        val job = purgeJobs.get(requested.type, requested.customerId, requested.itemId) ?: requested
        try {
            hide(job)
            purgeJobs.recordStage(job, maxOf(job.stage, STAGE_HIDDEN), clock().plus(PurgeJobRunner.LEASE))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            purgeJobs.reschedule(job, clock())
            throw e
        }
        if (created) {
            Metrics.count("purge_job_total", 1.0, "type" to job.type.name.lowercase(), "status" to "requested")
            appScope.launch { runner.execute(job.copy(stage = STAGE_HIDDEN), this@ContentDeletionService) }
        }
    }

    override suspend fun run(job: PurgeJob): PurgeOutcome {
        var stage = job.stage
        suspend fun completed(next: Int) {
            stage = next
            purgeJobs.recordStage(job, next, clock().plus(PurgeJobRunner.LEASE))
        }

        if (stage < STAGE_HIDDEN) { hide(job); completed(STAGE_HIDDEN) }
        if (stage < STAGE_CONTENT) { deleteContent(job); completed(STAGE_CONTENT) }
        if (stage < STAGE_VECTORS) { deleteVectors(job); completed(STAGE_VECTORS) }

        val finalSweepAt = job.requestedAt.plus(FINAL_SWEEP_DELAY)
        if (clock().isBefore(finalSweepAt)) return PurgeOutcome.WaitUntil(finalSweepAt)
        hide(job)
        deleteContent(job)
        deleteKeptFilesNoLongerUsed(job)
        deleteVectors(job)
        return PurgeOutcome.Done
    }

    private suspend fun hide(job: PurgeJob) {
        val itemId = job.itemId ?: return
        when (job.type) {
            PurgeJobType.CONVERSATION -> {
                purge.deleteConversationShares(itemId)
                purge.deleteConversationRow(job.customerId, itemId)
            }
            PurgeJobType.NOTE -> {
                purge.deleteNoteRow(job.customerId, itemId)
                purge.deletePendingVectorRow(job.customerId, itemId)
            }
            PurgeJobType.ACCOUNT -> Unit
        }
    }

    private suspend fun deleteContent(job: PurgeJob) {
        val itemId = job.itemId ?: return
        when (job.type) {
            PurgeJobType.CONVERSATION -> {
                deleteConversationFiles(job, itemId)
                val messages = purge.deleteMessages(itemId)
                purge.deletePendingVectorRows(job.customerId, itemId)
                purge.deleteMemoryBookkeeping(job.customerId, itemId)
                purge.deleteMemoryUsageOfConversation(job.customerId, itemId)
                purge.deleteInstructionUsageSeen(job.customerId, itemId)
                if (messages > 0) logger.info("Deleted {} message(s) of conversation {}", messages, itemId)
            }
            PurgeJobType.NOTE -> {
                if (documentsPurger.isConfigured) documentsPurger.purgeNote(job.customerId, itemId)
            }
            PurgeJobType.ACCOUNT -> Unit
        }
    }

    /**
     * Deletes the files the conversation's messages reference under the
     * owner's own prefix, except those another conversation in its fork tree
     * still uses; those are recorded on the job for the final sweep.
     */
    private suspend fun deleteConversationFiles(job: PurgeJob, conversationId: String) {
        val prefix = "customers/${job.customerId}/attachments/"
        val candidates = purge.messageFileKeys(conversationId).filterTo(mutableSetOf()) { it.startsWith(prefix) }
        if (candidates.isEmpty()) return
        val used = fileKeysUsedByForkTree(job, conversationId)
        val kept = candidates.intersect(used)
        deleteFiles(candidates - kept)
        purgeJobs.recordKeptFiles(job, kept)
    }

    private suspend fun deleteKeptFilesNoLongerUsed(job: PurgeJob) {
        val conversationId = job.itemId ?: return
        val kept = purgeJobs.get(job.type, job.customerId, conversationId)?.keptFileKeys.orEmpty()
        if (kept.isEmpty()) return
        val unused = kept - fileKeysUsedByForkTree(job, conversationId)
        deleteFiles(unused)
        purgeJobs.forgetKeptFiles(job, unused)
    }

    private suspend fun deleteFiles(keys: Set<String>) {
        if (keys.isEmpty()) return
        check(s3Provider.isConfigured) { "ATTACHMENTS_BUCKET is not set" }
        val failed = s3Provider.deleteObjects(keys.toList())
        check(failed.isEmpty()) { "${failed.size} file(s) could not be deleted" }
    }

    /** The file keys the other conversations in [conversationId]'s fork tree still reference. */
    private suspend fun fileKeysUsedByForkTree(job: PurgeJob, conversationId: String): Set<String> {
        val others = forkTree(conversationId, job.parentId, purge.conversationParents(job.customerId)) - conversationId
        return others.flatMapTo(mutableSetOf()) { purge.messageFileKeys(it) }
    }

    private suspend fun deleteVectors(job: PurgeJob) {
        val itemId = job.itemId ?: return
        try {
            when (job.type) {
                PurgeJobType.CONVERSATION -> retrievalServerClient.deleteConversationVectors(job.customerId, itemId)
                PurgeJobType.NOTE -> check(retrievalServerClient.deleteNoteVectors(job.customerId, itemId)) {
                    "Vector delete failed"
                }
                PurgeJobType.ACCOUNT -> Unit
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The vector DB is the customer's own: its cluster may be gone or
            // its credentials revoked. After enough attempts, finish without it.
            if (job.attempts < AccountDeletionService.VECTOR_ATTEMPTS) throw e
            logger.warn("Deletion job {}: the customer's vector DB could not be reached", job.jobKey)
            purgeJobs.addWarning(job, "vectors_not_deleted: the customer's vector DB could not be reached")
        }
    }

    companion object {
        const val STAGE_HIDDEN = 1
        const val STAGE_CONTENT = 2
        const val STAGE_VECTORS = 3

        val FINAL_SWEEP_DELAY: Duration = Duration.ofMinutes(15)

        /**
         * Every conversation connected to [conversationId] by forking,
         * [conversationId] included. [parents] maps each existing conversation
         * to the one it was forked from; [parentId] is [conversationId]'s own
         * parent, kept on the job because its row may already be gone.
         */
        internal fun forkTree(conversationId: String, parentId: String?, parents: Map<String, String?>): Set<String> {
            val neighbours = mutableMapOf<String, MutableSet<String>>()
            fun link(a: String, b: String) {
                neighbours.getOrPut(a) { mutableSetOf() } += b
                neighbours.getOrPut(b) { mutableSetOf() } += a
            }
            parents.forEach { (child, parent) -> if (parent != null) link(child, parent) }
            if (parentId != null) link(conversationId, parentId)

            val tree = mutableSetOf(conversationId)
            val queue = ArrayDeque(listOf(conversationId))
            while (queue.isNotEmpty()) {
                for (next in neighbours[queue.removeFirst()].orEmpty()) {
                    if (tree.add(next)) queue.addLast(next)
                }
            }
            return tree
        }
    }
}
