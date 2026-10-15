package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.models.api.AccountDeletionStatusResponse
import com.genflowly.observability.Metrics
import com.genflowly.providers.Auth0ManagementClient
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.EncodingPurgeClient
import com.genflowly.providers.RunDataClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerDataPurgeRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobState
import com.genflowly.repository.PurgeJobType
import com.genflowly.repository.RetentionTables
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.slf4j.LoggerFactory

class CustomerNotFoundException(message: String) : Exception(message)

/**
 * Customer deletion (plan 3.9). An admin request creates the account job
 * ("ACCOUNT#{customerId}" in PurgeJobs); [PurgeJobWorker] runs [run], which is
 * idempotent and resumes after the last completed stage:
 *
 * 1. stop new writes: delete the developer API keys and the Auth0 user (or,
 *    when the Management API is not configured or the login also holds
 *    another account, keep it and record a WARNING on the job);
 * 2. rename the CustomerProfile row to "Deleted User", re-keyed to
 *    sub = "DELETED#{customerId}", and delete the UsernameLookup row;
 *    then cancel the customer's in-flight turns and wait for them;
 * 3. classify the owned conversations (archived ones included): one with any
 *    share row (PUBLIC included) is kept; every other one gets a
 *    conversation purge job;
 * 4. + 5. build the keep set - every key linked from the kept conversations
 *    and from the customer's messages in other people's conversations
 *    (Message customerIdIndex) - and sweep customers/{customerId}/, deleting
 *    every other object (unsent uploads, scratch, orphans);
 * 6. delete the rest: the run data of the customer's kept messages, the
 *    customer-keyed rows (keeping the kept Conversation rows and the renamed
 *    profile), recipient share rows - purging orphaned conversations of
 *    deleted owners - shares of the customer's instructions and agents,
 *    instructions (except those System agents use), agent graphs, request
 *    agent overrides, the {customerId}_* vector collections and every version
 *    in the customer-documents bucket;
 * 7. wait until every conversation purge it enqueued is DONE.
 */
class AccountDeletionService(
    private val purgeJobRepository: PurgeJobRepository,
    private val customerProfileService: CustomerProfileService,
    private val customerProfileRepository: CustomerProfileRepository,
    private val conversationRepository: ConversationRepository,
    private val purgeRepository: CustomerDataPurgeRepository,
    private val s3Provider: S3Provider,
    private val runDataClient: RunDataClient,
    private val encodingPurgeClient: EncodingPurgeClient,
    private val documentsPurger: CustomerDocumentsPurger,
    private val auth0: Auth0ManagementClient,
    private val inFlightTurns: InFlightTurns,
    private val orphanedConversationPurge: OrphanedConversationPurge,
    private val clock: () -> Instant = Instant::now
) {
    private val logger = LoggerFactory.getLogger(AccountDeletionService::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    data class RequestResult(val job: PurgeJob, val created: Boolean)

    /**
     * Creates the account job (idempotent: a second request returns the
     * existing job). Throws IllegalArgumentException for a reserved id or
     * the caller's own account, CustomerNotFoundException when no profile
     * exists.
     */
    suspend fun requestDeletion(customerId: String, requestedBy: String): RequestResult {
        require(CUSTOMER_ID.matches(customerId) && customerId.lowercase() !in RESERVED_IDS) {
            "Not a deletable customer id"
        }
        require(customerId != requestedBy) { "An admin cannot delete their own account here" }
        val jobKey = RetentionTables.accountJobKey(customerId)
        purgeJobRepository.get(jobKey)?.let { return RequestResult(it, created = false) }

        val login = customerProfileService.findProfileLogin(customerId)
            ?: throw CustomerNotFoundException("No customer $customerId")
        val job = PurgeJob(
            jobKey = jobKey,
            type = PurgeJobType.ACCOUNT,
            customerId = customerId,
            authSub = login.sub.takeUnless { login.deleted },
            authClient = login.client.takeUnless { login.deleted },
            requestedBy = requestedBy
        )
        val created = purgeJobRepository.createIfAbsent(job)
        val stored = purgeJobRepository.get(jobKey) ?: job
        if (created) {
            Metrics.count("purge_jobs_total", 1.0, "operation" to "account", "status" to "requested")
            logger.warn("Customer {} deletion requested by admin {}", customerId, requestedBy)
        }
        return RequestResult(stored, created)
    }

    /** The account job and its conversation purges, or null when none was requested. */
    suspend fun status(customerId: String): AccountDeletionStatusResponse? {
        val job = purgeJobRepository.get(RetentionTables.accountJobKey(customerId)) ?: return null
        val children = job.childKeys.mapNotNull { purgeJobRepository.get(it) }
        return AccountDeletionStatusResponse(
            customerId = customerId,
            jobKey = job.jobKey,
            state = job.state,
            stage = job.stage,
            attempts = job.attempts,
            warnings = job.warnings,
            lastError = job.lastError,
            conversationPurges = job.childKeys.size,
            conversationPurgesDone = children.count { it.state == PurgeJobState.DONE },
            createdAt = job.createdAt,
            completedAt = job.completedAt
        )
    }

    /** One attempt of the account job; throws on failure (the worker backs off and retries). */
    suspend fun run(job: PurgeJob): PurgeOutcome {
        val customerId = job.customerId
        var stage = job.stage
        val childKeys = job.childKeys.toMutableSet()
        suspend fun completed(step: Int) {
            stage = step
            purgeJobRepository.recordStage(job.jobKey, step, clock().plus(PurgeJobWorker.LEASE))
        }

        if (stage < STAGE_STOP_WRITES) {
            stopWrites(job)
            completed(STAGE_STOP_WRITES)
        }
        if (stage < STAGE_RENAMED) {
            customerProfileService.markCustomerDeleted(customerId)
            // Nothing new can start now; let what is running end and persist
            val cancelled = inFlightTurns.cancelAndAwait(customerId, IN_FLIGHT_TIMEOUT.toMillis())
            if (cancelled > 0) logger.info("Cancelled {} in-flight turn(s) of deleted customer {}", cancelled, customerId)
            completed(STAGE_RENAMED)
        }
        if (stage < STAGE_CLASSIFIED) {
            childKeys += enqueueUnsharedConversationPurges(job)
            completed(STAGE_CLASSIFIED)
        }
        if (stage < STAGE_SWEPT) {
            sweepCustomerPrefix(job)
            completed(STAGE_SWEPT)
        }
        if (stage < STAGE_ROWS_DELETED) {
            deleteRemainingData(job)
            completed(STAGE_ROWS_DELETED)
        }

        val unfinished = childKeys.count { purgeJobRepository.get(it)?.state != PurgeJobState.DONE }
        if (unfinished > 0) {
            logger.info("Customer {} deletion waits for {} conversation purge(s)", customerId, unfinished)
            return PurgeOutcome.Reschedule("conversation purges")
        }
        logger.warn("Customer {} deletion finished", customerId)
        return PurgeOutcome.Done
    }

    // ── step 1 ───────────────────────────────────────────────────────────────

    private suspend fun stopWrites(job: PurgeJob) {
        val customerId = job.customerId
        val keys = purgeRepository.deleteDeveloperApiKeys(customerId)
        if (keys > 0) logger.info("Deleted {} developer API key(s) of customer {}", keys, customerId)

        val sub = job.authSub
        when {
            sub == null -> warn(job, "auth0_user_unknown: no login recorded; the Auth0 user was not removed")
            customerProfileRepository.customerIdsForSub(sub).any { it != customerId } ->
                warn(job, "auth0_user_kept: the login also holds another account")
            else -> when (auth0.deleteUser(sub)) {
                Auth0ManagementClient.DeleteResult.NOT_CONFIGURED ->
                    warn(job, "auth0_not_configured: AUTH0_MGMT_* is not set; the Auth0 user was not removed")
                else -> logger.info("Removed the Auth0 user of customer {}", customerId)
            }
        }
    }

    // ── step 3 ───────────────────────────────────────────────────────────────

    /** Purge jobs for every owned conversation without a share row; returns their keys. */
    private suspend fun enqueueUnsharedConversationPurges(job: PurgeJob): Set<String> {
        val customerId = job.customerId
        val unshared = conversationRepository.getOwnedConversationIds(customerId)
            .filter { purgeRepository.conversationShareRecipients(it).isEmpty() }
        for (conversationId in unshared) {
            purgeJobRepository.createIfAbsent(
                PurgeJob(
                    jobKey = conversationId,
                    type = PurgeJobType.CONVERSATION,
                    customerId = customerId,
                    conversationId = conversationId,
                    parentKey = job.jobKey
                )
            )
        }
        purgeJobRepository.addToSet(job.jobKey, CHILD_KEYS, unshared)
        logger.info("Customer {} deletion: {} conversation(s) to purge", customerId, unshared.size)
        return unshared.toSet()
    }

    // ── steps 4-6: keep set and backstop sweep ───────────────────────────────

    private suspend fun sweepCustomerPrefix(job: PurgeJob) {
        val customerId = job.customerId
        val keep = KeepSet()
        val keptConversations = keptOwnedConversations(customerId)
        for (conversationId in keptConversations) {
            conversationRepository.getMessageFileRefs(conversationId).forEach { keep.add(it) }
        }
        val runIds = mutableSetOf<String>()
        val beingPurged = mutableMapOf<String, Boolean>()
        for (key in conversationRepository.getMessageKeysByCustomer(customerId)) {
            // A conversation being purged takes its messages and run data with it
            val purged = key.conversationId !in keptConversations &&
                beingPurged.getOrPut(key.conversationId) { purgeJobRepository.get(key.conversationId) != null }
            if (purged) continue
            val refs = conversationRepository.getMessageFileRefs(key.conversationId, key.messageId) ?: continue
            keep.add(refs)
            refs.runId?.let { runIds += it }
        }
        // Deleted in step 6, after the sweep; recorded so a re-run still has them
        purgeJobRepository.addToSet(job.jobKey, ConversationPurgeService.RUN_IDS, runIds)

        val prefix = "customers/$customerId/"
        val doomed = s3Provider.listKeys(prefix).filter { RetentionKeys.isRetentionKey(it) && !keep.contains(it) }
        val stillFailing = s3Provider.deleteObjects(doomed)
        if (stillFailing.isNotEmpty()) {
            throw PurgeStepException("sweep", "${stillFailing.size} object(s) under the customer prefix could not be deleted")
        }
        if (doomed.isNotEmpty()) Metrics.count("purge_objects_deleted_total", doomed.size.toDouble(), "operation" to "sweep")
        logger.info(
            "Customer {} sweep: kept {} key(s) of {} conversation(s), deleted {} object(s)",
            customerId, keep.size, keptConversations.size, doomed.size
        )
    }

    /** Owned conversations that are shared (PUBLIC included) and not being purged. */
    private suspend fun keptOwnedConversations(customerId: String): Set<String> =
        conversationRepository.getOwnedConversationIds(customerId)
            .filter { purgeRepository.conversationShareRecipients(it).isNotEmpty() }
            .filter { purgeJobRepository.get(it) == null }
            .toSet()

    /** Exact keys plus the derived sidecars of kept primary keys. */
    private class KeepSet {
        private val exact = mutableSetOf<String>()
        private val prefixes = mutableSetOf<String>()

        val size: Int get() = exact.size

        fun add(message: MessageFileRefs) {
            exact += RetentionKeys.messageKeys(message.role, message.attachments, message.toolResultsJson).all
            message.attachments.map { it.s3Key }.filter { RetentionKeys.isRetentionKey(it) }
                .forEach { prefixes += RetentionKeys.derivedPrefix(it) }
        }

        fun contains(key: String): Boolean = key in exact || prefixes.any { key.startsWith(it) }
    }

    // ── step 6: everything else ──────────────────────────────────────────────

    private suspend fun deleteRemainingData(job: PurgeJob) {
        val customerId = job.customerId

        // Postgres run data of the customer's kept messages (purged conversations do their own)
        val runIds = purgeJobRepository.get(job.jobKey)?.runIds ?: job.runIds
        for (runId in runIds) {
            try {
                runDataClient.deleteRunData(runId)
            } catch (e: IllegalArgumentException) {
                logger.warn("Skipping a malformed run id of customer {}", customerId)
            }
        }
        // Every other run whose input is the customer's (rows written before
        // runId was stored, request agents the run sweep has not removed yet)
        // and the customer's tool-ledger rows, found on the retrieval-server
        val swept = runDataClient.deleteCustomerRunData(customerId)
        if (swept > 0) logger.info("Deleted {} more durable run(s) of customer {}", swept, customerId)

        // Shares of other people's conversations; a deleted owner's conversation left
        // without any share is purged (nobody can open it any more)
        for (conversationId in purgeRepository.recipientConversationIds(customerId)) {
            purgeRepository.deleteConversationShare(customerId, conversationId)
            val owner = conversationRepository.getConversationById(conversationId)?.customerId
            if (owner != null && owner != customerId) {
                orphanedConversationPurge.enqueueIfOrphaned(conversationId, owner)
            }
        }

        // Instructions and agents the customer created, and their shares
        val protectedInstructions = instructionsUsedBySystemAgents()
        val instructionIds = purgeRepository.instructionIdsByCreator(customerId)
        val kept = instructionIds.intersect(protectedInstructions)
        if (kept.isNotEmpty()) {
            warn(job, "instructions_kept: ${kept.size} instruction(s) are used by System agents")
        }
        val graphIds = purgeRepository.ownedGraphIds(customerId)
        val nodeIds = purgeRepository.ownedNodeIds(customerId)
        purgeRepository.deleteEntityShares((instructionIds - kept) + graphIds)
        for (id in instructionIds - kept) purgeRepository.deleteAllVersions(CustomerDataPurgeRepository.INSTRUCTION_VERSIONS, id)
        for (id in graphIds) purgeRepository.deleteAllVersions(CustomerDataPurgeRepository.GRAPH_VERSIONS, id)
        for (id in nodeIds) purgeRepository.deleteAllVersions(CustomerDataPurgeRepository.NODE_VERSIONS, id)
        purgeRepository.deletePartition(CustomerDataPurgeRepository.REQUEST_AGENT_MAP, customerId)

        // Every customer-keyed partition (recipient instruction shares, memories, notes, ...)
        for (table in CustomerDataPurgeRepository.CUSTOMER_PARTITION_TABLES) {
            purgeRepository.deletePartition(table, customerId)
        }

        // Vectors, while CustomerVectorDBConfig still names a customer-specific cluster
        if (encodingPurgeClient.isConfigured) {
            encodingPurgeClient.dropCustomerCollections(customerId)
        } else {
            warn(job, "vector_purge_skipped: the encoding-server purge is not configured")
        }
        purgeRepository.deletePartition(CustomerDataPurgeRepository.VECTOR_DB_CONFIG, customerId)

        val versions = documentsPurger.purgeCustomer(customerId)
        if (versions > 0) {
            Metrics.count("purge_objects_deleted_total", versions.toDouble(), "operation" to "documents")
        }
    }

    /**
     * Instruction ids the System-owned agents' nodes reference. Mapping an
     * admin's agent as a System default transfers the graph and nodes to
     * System but leaves the instructions with the admin, so deleting them
     * would break that default. A node config whose JSON does not parse is
     * skipped: the retrieval server cannot run that node either.
     */
    private suspend fun instructionsUsedBySystemAgents(): Set<String> =
        purgeRepository.nodeConfigs(DynamoDBConstants.SYSTEM_GRAPH_OWNER).flatMap { config ->
            try {
                instructionRefs(json.parseToJsonElement(config))
            } catch (e: SerializationException) {
                logger.warn("Skipping a System node config that is not valid JSON")
                emptyList()
            }
        }.toSet()

    private suspend fun warn(job: PurgeJob, warning: String) {
        logger.warn("Purge job {}: {}", job.jobKey, warning)
        purgeJobRepository.addWarning(job.jobKey, warning)
    }

    companion object {
        const val STAGE_STOP_WRITES = 1
        const val STAGE_RENAMED = 2
        const val STAGE_CLASSIFIED = 3
        const val STAGE_SWEPT = 4
        const val STAGE_ROWS_DELETED = 5

        const val CHILD_KEYS = "childKeys"
        val IN_FLIGHT_TIMEOUT: Duration = Duration.ofMinutes(2)
        private val CUSTOMER_ID = Regex("^[A-Za-z0-9-]{1,64}$")
        private val RESERVED_IDS = setOf("system", "public")

        /**
         * Node-config keys that hold an instruction id, in snake_case as the
         * retrieval server reads them: `instruction_id` (any node's persona,
         * routes/retrieve.py _build_node_configs, and each TOOL_EXECUTOR
         * subagent profile, graph/subagent.py) and `harness_instruction_id`
         * (agent harness scaffolding).
         */
        private val INSTRUCTION_REF_KEYS = setOf("instruction_id", "harness_instruction_id")

        /**
         * Every non-blank instruction reference in a node config, at any depth
         * (subagent profiles nest inside the TOOL_EXECUTOR config and inside
         * each other).
         */
        internal fun instructionRefs(element: JsonElement): List<String> = when (element) {
            is JsonObject -> element.entries.flatMap { (key, value) ->
                val ref = if (key in INSTRUCTION_REF_KEYS) {
                    (value as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
                } else null
                listOfNotNull(ref) + instructionRefs(value)
            }
            is JsonArray -> element.flatMap { instructionRefs(it) }
            else -> emptyList()
        }
    }
}
