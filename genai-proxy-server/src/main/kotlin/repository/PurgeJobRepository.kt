package com.genflowly.repository

import com.genflowly.repository.RetentionTables.PURGE_DUE_AT_KEY
import com.genflowly.repository.RetentionTables.PURGE_JOBS_TABLE
import com.genflowly.repository.RetentionTables.PURGE_JOB_KEY
import com.genflowly.repository.RetentionTables.PURGE_PENDING_INDEX
import com.genflowly.repository.RetentionTables.PURGE_PENDING_SHARD_KEY
import com.genflowly.repository.RetentionTables.PURGE_PENDING_SHARD_VALUE
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

enum class PurgeJobType { ACCOUNT, CONVERSATION }

object PurgeJobState {
    const val PENDING = "PENDING"
    const val RUNNING = "RUNNING"
    const val DONE = "DONE"
}

/**
 * One row of the PurgeJobs table: an account deletion ("ACCOUNT#{customerId}")
 * or a conversation purge (keyed by the conversationId).
 */
data class PurgeJob(
    val jobKey: String,
    val type: PurgeJobType,
    /** ACCOUNT: the deleted customer. CONVERSATION: the conversation's owner. */
    val customerId: String,
    val conversationId: String? = null,
    val state: String = PurgeJobState.PENDING,
    /** Failed attempts (backoff grows with it; alerting starts at 10). */
    val attempts: Int = 0,
    /** Conversation purge: times it waited for a pending durable run. */
    val reschedules: Int = 0,
    val leaseUntil: String? = null,
    val dueAt: String? = null,
    /** ACCOUNT: the last step completed, so a re-run resumes after it. */
    val stage: Int = 0,
    val warnings: List<String> = emptyList(),
    /** ACCOUNT: the login (Auth0 sub and app client) to remove; dropped when the job is DONE. */
    val authSub: String? = null,
    val authClient: String? = null,
    /** CONVERSATION: the account job that enqueued it, if any. */
    val parentKey: String? = null,
    /** ACCOUNT: the conversation purges it enqueued. */
    val childKeys: Set<String> = emptySet(),
    /** Durable runs seen in pendingRuns, kept until their run data is deleted. */
    val runIds: Set<String> = emptySet(),
    val requestedBy: String? = null,
    val lastError: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val completedAt: String? = null
)

/**
 * Data access for the PurgeJobs table: a work queue drained through the
 * sparse pending index (only unfinished jobs carry pendingShard), leased with
 * a conditional update so two workers never run one job.
 */
class PurgeJobRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /** Creates the job unless one with the same key exists; true when created. */
    suspend fun createIfAbsent(job: PurgeJob, now: Instant = Instant.now()): Boolean = withContext(Dispatchers.IO) {
        val item = buildMap {
            put(PURGE_JOB_KEY, s(job.jobKey))
            put("jobType", s(job.type.name))
            put("customerId", s(job.customerId))
            job.conversationId?.let { put("conversationId", s(it)) }
            put("state", s(PurgeJobState.PENDING))
            put("attempts", n(0))
            put("reschedules", n(0))
            put("stage", n(0))
            put(PURGE_PENDING_SHARD_KEY, s(PURGE_PENDING_SHARD_VALUE))
            put(PURGE_DUE_AT_KEY, s(now.toString()))
            job.authSub?.let { put("authSub", s(it)) }
            job.authClient?.let { put("authClient", s(it)) }
            job.parentKey?.let { put("parentKey", s(it)) }
            job.requestedBy?.let { put("requestedBy", s(it)) }
            put("createdAt", s(now.toString()))
            put("updatedAt", s(now.toString()))
        }
        try {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(PURGE_JOBS_TABLE)
                    .item(item)
                    .conditionExpression("attribute_not_exists(#k)")
                    .expressionAttributeNames(mapOf("#k" to PURGE_JOB_KEY))
                    .build()
            )
            logger.info { "Created ${job.type} purge job ${job.jobKey}" }
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun get(jobKey: String): PurgeJob? = withContext(Dispatchers.IO) {
        dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(PURGE_JOBS_TABLE)
                .key(key(jobKey))
                .consistentRead(true)
                .build()
        ).item()?.takeIf { it.isNotEmpty() }?.let { itemToJob(it) }
    }

    /** Unfinished jobs due at or before [now], oldest first. */
    suspend fun dueJobs(now: Instant, limit: Int): List<PurgeJob> = withContext(Dispatchers.IO) {
        dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(PURGE_JOBS_TABLE)
                .indexName(PURGE_PENDING_INDEX)
                .keyConditionExpression("#shard = :shard AND #due <= :now")
                .expressionAttributeNames(mapOf("#shard" to PURGE_PENDING_SHARD_KEY, "#due" to PURGE_DUE_AT_KEY))
                .expressionAttributeValues(mapOf(
                    ":shard" to s(PURGE_PENDING_SHARD_VALUE),
                    ":now" to s(now.toString())
                ))
                .limit(limit)
                .build()
        ).items().mapNotNull { itemToJob(it) }
    }

    /**
     * Takes the job's lease until [leaseUntil] when it is unfinished and not
     * leased by someone else (no lease, or an expired one). False otherwise.
     */
    suspend fun tryLease(jobKey: String, now: Instant, leaseUntil: Instant): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(PURGE_JOBS_TABLE)
                    .key(key(jobKey))
                    .updateExpression("SET #lease = :lease, #state = :running, updatedAt = :now")
                    .conditionExpression(
                        "attribute_exists(#shard) AND (attribute_not_exists(#lease) OR #lease < :now)"
                    )
                    .expressionAttributeNames(mapOf(
                        "#lease" to "leaseUntil", "#state" to "state", "#shard" to PURGE_PENDING_SHARD_KEY
                    ))
                    .expressionAttributeValues(mapOf(
                        ":lease" to s(leaseUntil.toString()),
                        ":running" to s(PurgeJobState.RUNNING),
                        ":now" to s(now.toString())
                    ))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    /** Records progress and extends the lease (account job steps). */
    suspend fun recordStage(jobKey: String, stage: Int, leaseUntil: Instant) = update(
        jobKey,
        "SET stage = :stage, #lease = :lease, updatedAt = :now",
        mapOf("#lease" to "leaseUntil"),
        mapOf(":stage" to n(stage), ":lease" to s(leaseUntil.toString()))
    )

    /** Appends a WARNING note (e.g. a skipped step) unless it is already recorded. */
    suspend fun addWarning(jobKey: String, warning: String) {
        val current = get(jobKey) ?: return
        if (warning in current.warnings) return
        update(
            jobKey,
            "SET warnings = list_append(if_not_exists(warnings, :empty), :w), updatedAt = :now",
            emptyMap(),
            mapOf(
                ":w" to AttributeValue.builder().l(s(warning)).build(),
                ":empty" to AttributeValue.builder().l(emptyList<AttributeValue>()).build()
            )
        )
    }

    /** Adds to a String Set attribute ("childKeys" or "runIds"). */
    suspend fun addToSet(jobKey: String, attribute: String, values: Collection<String>) {
        if (values.isEmpty()) return
        update(
            jobKey,
            "ADD #set :v SET updatedAt = :now",
            mapOf("#set" to attribute),
            mapOf(":v" to AttributeValue.builder().ss(values.toSet()).build())
        )
    }

    /**
     * Releases the lease and makes the job due again at [dueAt]. [failed]
     * counts a failed attempt (recording [error], which must hold no user
     * content); [rescheduled] counts a wait for a pending run.
     */
    suspend fun reschedule(
        jobKey: String,
        dueAt: Instant,
        failed: Boolean,
        rescheduled: Boolean,
        error: String?
    ) {
        val sets = mutableListOf("#state = :pending", "#due = :due", "updatedAt = :now")
        val values = mutableMapOf(":pending" to s(PurgeJobState.PENDING), ":due" to s(dueAt.toString()))
        val adds = mutableListOf<String>()
        if (failed) {
            adds += "attempts :one"
            values[":one"] = n(1)
        }
        if (rescheduled) {
            adds += "reschedules :one"
            values[":one"] = n(1)
        }
        if (error != null) {
            sets += "lastError = :err"
            values[":err"] = s(error.take(500))
        }
        val expression = "SET ${sets.joinToString(", ")} REMOVE #lease" +
            (if (adds.isNotEmpty()) " ADD ${adds.joinToString(", ")}" else "")
        update(jobKey, expression, mapOf("#state" to "state", "#due" to PURGE_DUE_AT_KEY, "#lease" to "leaseUntil"), values)
    }

    /**
     * Marks the job DONE: it leaves the pending index, its lease is released,
     * and the login it recorded (authSub/authClient) is dropped.
     */
    suspend fun complete(jobKey: String) = update(
        jobKey,
        "SET #state = :done, completedAt = :now, updatedAt = :now " +
            "REMOVE #shard, #due, #lease, authSub, authClient, lastError",
        mapOf("#state" to "state", "#shard" to PURGE_PENDING_SHARD_KEY, "#due" to PURGE_DUE_AT_KEY, "#lease" to "leaseUntil"),
        mapOf(":done" to s(PurgeJobState.DONE))
    )

    private suspend fun update(
        jobKey: String,
        expression: String,
        names: Map<String, String>,
        values: Map<String, AttributeValue>
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(PURGE_JOBS_TABLE)
                .key(key(jobKey))
                .updateExpression(expression)
                .conditionExpression("attribute_exists(#k)")
                .expressionAttributeNames(names + ("#k" to PURGE_JOB_KEY))
                .expressionAttributeValues(values + (":now" to s(Instant.now().toString())))
                .build()
        )
        Unit
    }

    private fun itemToJob(item: Map<String, AttributeValue>): PurgeJob? {
        val jobKey = item[PURGE_JOB_KEY]?.s() ?: return null
        val type = item["jobType"]?.s()?.let { runCatching { PurgeJobType.valueOf(it) }.getOrNull() } ?: return null
        return PurgeJob(
            jobKey = jobKey,
            type = type,
            customerId = item["customerId"]?.s() ?: return null,
            conversationId = item["conversationId"]?.s(),
            state = item["state"]?.s() ?: PurgeJobState.PENDING,
            attempts = item["attempts"]?.n()?.toIntOrNull() ?: 0,
            reschedules = item["reschedules"]?.n()?.toIntOrNull() ?: 0,
            leaseUntil = item["leaseUntil"]?.s(),
            dueAt = item[PURGE_DUE_AT_KEY]?.s(),
            stage = item["stage"]?.n()?.toIntOrNull() ?: 0,
            warnings = item["warnings"]?.l()?.mapNotNull { it.s() } ?: emptyList(),
            authSub = item["authSub"]?.s(),
            authClient = item["authClient"]?.s(),
            parentKey = item["parentKey"]?.s(),
            childKeys = item["childKeys"]?.ss()?.toSet() ?: emptySet(),
            runIds = item["runIds"]?.ss()?.toSet() ?: emptySet(),
            requestedBy = item["requestedBy"]?.s(),
            lastError = item["lastError"]?.s(),
            createdAt = item["createdAt"]?.s(),
            updatedAt = item["updatedAt"]?.s(),
            completedAt = item["completedAt"]?.s()
        )
    }

    private fun key(jobKey: String) = mapOf(PURGE_JOB_KEY to s(jobKey))
    private fun s(v: String) = AttributeValue.builder().s(v).build()
    private fun n(v: Int) = AttributeValue.builder().n(v.toString()).build()
}
