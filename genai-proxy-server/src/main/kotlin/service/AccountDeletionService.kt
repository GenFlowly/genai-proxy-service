package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.config.AppConfig
import com.genflowly.di.AppScope
import com.genflowly.observability.Metrics
import com.genflowly.providers.Auth0ManagementClient
import com.genflowly.providers.CustomerDocumentsPurger
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.S3Provider
import com.genflowly.repository.PurgeRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobRepository
import com.genflowly.repository.PurgeJobType
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.slf4j.LoggerFactory

/** The account can't be deleted this way (e.g. an admin-panel account). */
class AccountDeletionRefusedException(message: String) : Exception(message)

/**
 * Self-service account deletion.
 *
 * [requestDeletion] records a job in PurgeJobs, then cuts the login off from
 * the account before it returns: developer API keys, the profile row and the
 * username go first, so no request can reach the account again and the next
 * sign-in creates a new, empty account. [run] deletes everything else in
 * stages, each idempotent, recording the last stage that completed;
 * [PurgeJobWorker] re-runs any job that a restart or a failure interrupted,
 * with backoff.
 *
 * Content goes before the vectors, so the encoding pipeline (which reloads
 * text from the source rows) can't store new vectors after the purge, and
 * the vectors go before the credentials that reach the customer's vector DB.
 * A reply still generating when deletion starts can write after the content
 * stage, so content, credentials and files are swept once more
 * [FINAL_SWEEP_DELAY] after the request.
 *
 * Everything the account owns is deleted, shared conversations included:
 * their links stop working and recipients lose access. Messages the customer
 * wrote in other people's conversations stay with those conversations.
 */
class AccountDeletionService(
    private val purgeJobs: PurgeJobRepository,
    private val runner: PurgeJobRunner,
    private val purge: PurgeRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val s3Provider: S3Provider,
    private val documentsPurger: CustomerDocumentsPurger,
    private val retrievalServerClient: RetrievalServerClient,
    private val auth0: Auth0ManagementClient,
    private val appScope: AppScope,
    private val clock: () -> Instant = Instant::now
) : PurgeJobHandler {
    private val logger = LoggerFactory.getLogger(AccountDeletionService::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Starts deleting the account and returns once it is unreachable.
     * Idempotent: asking again repeats the disconnect and leaves the rest to
     * the job already running. Throws when the disconnect fails; the job
     * stays, and the sweep retries it.
     */
    suspend fun requestDeletion(customerId: String) {
        require(isDeletableCustomerId(customerId)) { "Not a deletable customer id" }
        val profile = customerProfileRepository.getCustomerProfileByCustomerId(customerId)
        val client = profile?.get(DynamoDBConstants.CLIENT_SORT_KEY)?.s()
        if (client == AppConfig.CLIENT_ADMIN_PANEL) {
            throw AccountDeletionRefusedException("Admin-panel accounts can't be deleted here")
        }

        val now = clock()
        val requested = PurgeJob(
            type = PurgeJobType.ACCOUNT,
            customerId = customerId,
            sub = profile?.get(DynamoDBConstants.SUB_PARTITION_KEY)?.s(),
            client = client,
            username = profile?.get(DynamoDBConstants.USERNAME_KEY)?.s(),
            requestedAt = now
        )
        val created = purgeJobs.createIfAbsent(requested, dueAt = now.plus(PurgeJobRunner.LEASE))
        val job = purgeJobs.get(PurgeJobType.ACCOUNT, customerId) ?: requested
        if (created) {
            Metrics.count("purge_job_total", 1.0, "type" to "account", "status" to "requested")
            logger.warn("Account deletion requested for customer {}", customerId)
        }

        try {
            disconnect(job)
            purgeJobs.recordStage(job, maxOf(job.stage, STAGE_DISCONNECTED), clock().plus(PurgeJobRunner.LEASE))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            purgeJobs.reschedule(job, clock())
            throw e
        }
        if (created) {
            appScope.launch { runner.execute(job.copy(stage = STAGE_DISCONNECTED), this@AccountDeletionService) }
        }
    }

    /** One attempt from the job's recorded stage. Throws on failure, and the caller backs off. */
    override suspend fun run(job: PurgeJob): PurgeOutcome {
        val customerId = job.customerId
        var stage = job.stage
        suspend fun completed(next: Int) {
            stage = next
            purgeJobs.recordStage(job, next, clock().plus(PurgeJobRunner.LEASE))
        }

        if (stage < STAGE_DISCONNECTED) { disconnect(job); completed(STAGE_DISCONNECTED) }
        if (stage < STAGE_CONTENT) { deleteContent(job); completed(STAGE_CONTENT) }
        if (stage < STAGE_VECTORS) { deleteVectors(job); completed(STAGE_VECTORS) }
        if (stage < STAGE_CREDENTIALS) { deleteCredentials(customerId); completed(STAGE_CREDENTIALS) }
        if (stage < STAGE_FILES) { deleteFiles(job); completed(STAGE_FILES) }
        if (stage < STAGE_LOGIN) { deleteLogin(job); completed(STAGE_LOGIN) }

        val finalSweepAt = job.requestedAt.plus(FINAL_SWEEP_DELAY)
        if (clock().isBefore(finalSweepAt)) return PurgeOutcome.WaitUntil(finalSweepAt)
        deleteContent(job)
        deleteCredentials(customerId)
        deleteFiles(job)
        return PurgeOutcome.Done
    }

    private suspend fun disconnect(job: PurgeJob) {
        purge.deleteDeveloperApiKeys(job.customerId)
        if (job.sub != null && job.client != null) purge.deleteProfile(job.sub, job.client, job.customerId)
        job.username?.let { purge.deleteUsername(it, job.customerId) }
    }

    private suspend fun deleteContent(job: PurgeJob) {
        val customerId = job.customerId
        val conversations = purge.ownedConversationIds(customerId)
        conversations.forEachIndexed { index, conversationId ->
            purge.deleteConversation(customerId, conversationId)
            if ((index + 1) % LEASE_RENEW_EVERY == 0) purgeJobs.reschedule(job, clock().plus(PurgeJobRunner.LEASE))
        }
        purge.deleteSharesWith(customerId)
        purge.deleteBlocks(customerId)

        val instructions = purge.instructionIdsByCreator(customerId)
        val kept = instructions.intersect(instructionsUsedBySystemAgents())
        if (kept.isNotEmpty()) warn(job, "instructions_kept: ${kept.size} instruction(s) are used by System agents")
        (instructions - kept).forEach { purge.deleteInstruction(it) }
        purge.ownedGraphIds(customerId).forEach { purge.deleteGraph(it) }
        purge.ownedNodeIds(customerId).forEach { purge.deleteNode(it) }
        purge.deleteRequestAgentOverrides(customerId)
        purge.deleteDeveloperApiKeys(customerId)
        for ((table, sortKey) in CONTENT_PARTITIONS) purge.deleteCustomerPartition(customerId, table, sortKey)
        logger.info("Deleted the content of customer {} ({} conversation(s))", customerId, conversations.size)
    }

    private suspend fun deleteVectors(job: PurgeJob) {
        try {
            val deleted = retrievalServerClient.deleteCustomerVectors(job.customerId)
            logger.info("Deleted {} vector(s) of customer {}", deleted, job.customerId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The vector DB is the customer's own: its cluster may be gone or
            // its credentials revoked. After enough attempts, finish without it.
            if (job.attempts < VECTOR_ATTEMPTS) throw e
            warn(job, "vectors_not_deleted: the customer's vector DB could not be reached")
        }
    }

    private suspend fun deleteCredentials(customerId: String) {
        for ((table, sortKey) in CREDENTIAL_PARTITIONS) purge.deleteCustomerPartition(customerId, table, sortKey)
    }

    private suspend fun deleteFiles(job: PurgeJob) {
        if (s3Provider.isConfigured) {
            val keys = s3Provider.listKeys("customers/${job.customerId}/")
            val failed = s3Provider.deleteObjects(keys)
            check(failed.isEmpty()) { "${failed.size} file(s) could not be deleted" }
            if (keys.isNotEmpty()) logger.info("Deleted {} file(s) of customer {}", keys.size, job.customerId)
        } else {
            warn(job, "attachments_not_configured: ATTACHMENTS_BUCKET is not set")
        }
        if (documentsPurger.isConfigured) {
            val versions = documentsPurger.purgeCustomer(job.customerId)
            if (versions > 0) logger.info("Deleted {} note document version(s) of customer {}", versions, job.customerId)
        } else {
            warn(job, "customer_documents_not_configured: CUSTOMER_DOCUMENTS_BUCKET is not set")
        }
    }

    private suspend fun deleteLogin(job: PurgeJob) {
        val sub = job.sub ?: return warn(job, "auth0_user_unknown: no login was recorded")
        if (purge.customerIdsForSub(sub).any { it != job.customerId }) {
            return warn(job, "auth0_user_kept: the login also holds another account")
        }
        when (auth0.deleteUser(sub)) {
            Auth0ManagementClient.DeleteResult.DELETED ->
                logger.info("Removed the Auth0 user of customer {}", job.customerId)
            Auth0ManagementClient.DeleteResult.NOT_FOUND ->
                logger.info("The Auth0 user of customer {} was already gone", job.customerId)
            Auth0ManagementClient.DeleteResult.NOT_CONFIGURED ->
                warn(job, "auth0_not_configured: AUTH0_MGMT_* is not set, so the Auth0 user was kept")
        }
    }

    /**
     * Instruction ids the System's nodes reference. Promoting an agent to a
     * System default moves its graph and nodes to System but leaves its
     * instructions with their creator, so deleting them would break that
     * default. A node config that isn't valid JSON is skipped: no agent can
     * run that node either.
     */
    private suspend fun instructionsUsedBySystemAgents(): Set<String> =
        purge.systemNodeConfigs().flatMap { config ->
            try {
                instructionRefs(json.parseToJsonElement(config))
            } catch (e: SerializationException) {
                emptyList()
            }
        }.toSet()

    private suspend fun warn(job: PurgeJob, warning: String) {
        logger.warn("Account deletion for customer {}: {}", job.customerId, warning)
        purgeJobs.addWarning(job, warning)
    }

    companion object {
        const val STAGE_DISCONNECTED = 1
        const val STAGE_CONTENT = 2
        const val STAGE_VECTORS = 3
        const val STAGE_CREDENTIALS = 4
        const val STAGE_FILES = 5
        const val STAGE_LOGIN = 6

        val FINAL_SWEEP_DELAY: Duration = Duration.ofMinutes(15)
        private const val LEASE_RENEW_EVERY = 100
        const val VECTOR_ATTEMPTS = 6

        private val CUSTOMER_ID = Regex("^[A-Za-z0-9-]{1,64}$")
        private val RESERVED_IDS = setOf("system", "public")

        /** Ids we generate; anything else could widen a "customers/{id}/" or "{id}/" file prefix. */
        fun isDeletableCustomerId(customerId: String): Boolean =
            CUSTOMER_ID.matches(customerId) && customerId.lowercase() !in RESERVED_IDS

        /** The customer's partitions, other than conversations, deleted with the content. */
        private val CONTENT_PARTITIONS = listOf(
            DynamoDBConstants.CUSTOMER_NOTES_TABLE to DynamoDBConstants.NOTE_KEY,
            DynamoDBConstants.CUSTOMER_MEMORY_TABLE to DynamoDBConstants.MEMORY_ID_KEY,
            DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE to null,
            DynamoDBConstants.CUSTOMER_PROJECTS_TABLE to DynamoDBConstants.PROJECT_ID_KEY,
            DynamoDBConstants.CUSTOMER_USAGE_TABLE to DynamoDBConstants.USAGE_DATE_SORT_KEY,
            DynamoDBConstants.INSTRUCTION_USAGE_TABLE to DynamoDBConstants.INSTRUCTION_ID_KEY,
            DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE to DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY,
            DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE to DynamoDBConstants.VECTOR_SYNC_ITEM_KEY,
            DynamoDBConstants.CUSTOMER_TOOLS_TABLE to DynamoDBConstants.TOOL_NAME_KEY,
        )

        /** Keys and connection settings, deleted only after the vectors they reach. */
        private val CREDENTIAL_PARTITIONS = listOf(
            DynamoDBConstants.CUSTOMER_API_KEY_TABLE to DynamoDBConstants.AI_VENDOR_KEY,
            DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE to null,
            DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE to DynamoDBConstants.TOOL_TYPE_KEY,
            DynamoDBConstants.CUSTOMER_EMBEDDING_MODELS_TABLE to DynamoDBConstants.VENDOR_KEY,
        )

        /**
         * Node-config keys holding an instruction id, in the snake_case the
         * retrieval server reads: `instruction_id` (a node's persona and each
         * TOOL_EXECUTOR subagent profile) and `harness_instruction_id`.
         */
        private val INSTRUCTION_REF_KEYS = setOf("instruction_id", "harness_instruction_id")

        /** Every non-blank instruction reference in a node config, at any depth. */
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
