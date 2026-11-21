package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.ReturnValue
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

enum class PurgeJobType { ACCOUNT, CONVERSATION, NOTE }

/**
 * One deletion in progress, as a PurgeJobs row: a whole account, or one
 * conversation or note ([itemId] is its conversationId or noteKey). [stage]
 * is the last stage that completed. Account jobs also carry the login and
 * username to remove ([sub], [client], [username]), and a conversation job
 * carries the conversation it was forked from ([parentId]): its row is gone
 * by the time its files are deleted, and files are shared along forks.
 * [keptFileKeys] are the files it kept because another conversation still
 * used them, for the final sweep to check again. The login and username are
 * dropped from the row once the job finishes.
 */
data class PurgeJob(
    val type: PurgeJobType,
    val customerId: String,
    val itemId: String? = null,
    val requestedAt: Instant,
    val stage: Int = 0,
    val attempts: Int = 0,
    /** When the job may next be claimed; null once it is done. */
    val dueAt: String? = null,
    val sub: String? = null,
    val client: String? = null,
    val username: String? = null,
    val parentId: String? = null,
    val keptFileKeys: Set<String> = emptySet()
) {
    val jobKey: String get() = PurgeJobRepository.jobKey(type, customerId, itemId)
}

/**
 * Deletion jobs in the PurgeJobs table. Pending jobs carry the constant
 * pendingShard attribute, so the sparse pending-purge-index holds exactly the
 * jobs still to run, ordered by dueAt.
 */
class PurgeJobRepository(private val dynamoDbClient: DynamoDbClient) {

    /** Stores [job] unless one already exists under its key. Returns true when it stored it. */
    suspend fun createIfAbsent(job: PurgeJob, dueAt: Instant): Boolean = withContext(Dispatchers.IO) {
        val item = buildMap {
            put(JOB_KEY, s(job.jobKey))
            put(TYPE, s(job.type.name))
            put(DynamoDBConstants.CUSTOMER_ID_KEY, s(job.customerId))
            job.itemId?.let { put(ITEM_ID, s(it)) }
            job.sub?.let { put(SUB, s(it)) }
            job.client?.let { put(CLIENT, s(it)) }
            job.username?.let { put(USERNAME, s(it)) }
            job.parentId?.let { put(PARENT_ID, s(it)) }
            put(REQUESTED_AT, s(job.requestedAt.toString()))
            put(STAGE, n(job.stage))
            put(ATTEMPTS, n(0))
            put(PENDING_SHARD, s(PENDING))
            put(DUE_AT, s(dueAt.toString()))
        }
        try {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(TABLE)
                    .item(item)
                    .conditionExpression("attribute_not_exists($JOB_KEY)")
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun get(type: PurgeJobType, customerId: String, itemId: String? = null): PurgeJob? =
        withContext(Dispatchers.IO) {
            dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(TABLE)
                    .key(mapOf(JOB_KEY to s(jobKey(type, customerId, itemId))))
                    .consistentRead(true)
                    .build()
            ).item()?.takeIf { it.isNotEmpty() }?.let(::toJob)
        }

    /** Pending jobs of every type whose dueAt has passed, oldest first. */
    suspend fun dueJobs(now: Instant, limit: Int): List<PurgeJob> = withContext(Dispatchers.IO) {
        dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(TABLE)
                .indexName(INDEX)
                .keyConditionExpression("$PENDING_SHARD = :shard AND $DUE_AT <= :now")
                .expressionAttributeValues(mapOf(":shard" to s(PENDING), ":now" to s(now.toString())))
                .limit(limit)
                .build()
        ).items().mapNotNull(::toJob)
    }

    /**
     * Claims the job for one attempt: bumps attempts and moves dueAt to
     * [leaseUntil], so no other instance runs it meanwhile and a crash hands
     * it to the next sweep. Conditional on the dueAt the caller read. Returns
     * the claimed job, or null when another instance claimed it first or it
     * finished.
     */
    suspend fun claim(job: PurgeJob, leaseUntil: Instant): PurgeJob? = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(TABLE)
                    .key(mapOf(JOB_KEY to s(job.jobKey)))
                    .updateExpression("SET $ATTEMPTS = $ATTEMPTS + :one, $DUE_AT = :lease")
                    .conditionExpression("attribute_exists($PENDING_SHARD) AND $DUE_AT = :seen")
                    .expressionAttributeValues(
                        mapOf(":one" to n(1), ":lease" to s(leaseUntil.toString()), ":seen" to s(job.dueAt ?: ""))
                    )
                    .returnValues(ReturnValue.ALL_NEW)
                    .build()
            ).attributes()?.let(::toJob)
        } catch (e: ConditionalCheckFailedException) {
            null
        }
    }

    /** Records that [stage] completed and extends the lease to [leaseUntil]. */
    suspend fun recordStage(job: PurgeJob, stage: Int, leaseUntil: Instant) =
        update(job, "SET $STAGE = :stage, $DUE_AT = :lease", mapOf(":stage" to n(stage), ":lease" to s(leaseUntil.toString())))

    /** Adds [keys] to the files the job kept because another conversation still used them. */
    suspend fun recordKeptFiles(job: PurgeJob, keys: Set<String>) {
        if (keys.isEmpty()) return
        update(job, "ADD $KEPT_FILE_KEYS :k", mapOf(":k" to AttributeValue.builder().ss(keys).build()))
    }

    /** Removes [keys] from the files the job kept, once they are deleted. */
    suspend fun forgetKeptFiles(job: PurgeJob, keys: Set<String>) {
        if (keys.isEmpty()) return
        update(job, "DELETE $KEPT_FILE_KEYS :k", mapOf(":k" to AttributeValue.builder().ss(keys).build()))
    }

    /** Makes the job due again at [at]. */
    suspend fun reschedule(job: PurgeJob, at: Instant) =
        update(job, "SET $DUE_AT = :due", mapOf(":due" to s(at.toString())))

    /** Records a problem that did not stop the job (e.g. a vector DB we could not reach). */
    suspend fun addWarning(job: PurgeJob, warning: String) =
        update(job, "ADD $WARNINGS :w", mapOf(":w" to AttributeValue.builder().ss(warning).build()))

    suspend fun recordError(job: PurgeJob, error: String) =
        update(job, "SET $LAST_ERROR = :e", mapOf(":e" to s(error.take(MAX_ERROR_CHARS))))

    /**
     * Marks the job done: it leaves the pending index, and the login and
     * username it no longer needs are removed from the row. `state` and `sub`
     * are DynamoDB reserved words, so both go through aliases.
     */
    suspend fun complete(job: PurgeJob, at: Instant) =
        update(
            job,
            "SET #state = :done, $COMPLETED_AT = :at REMOVE $PENDING_SHARD, $DUE_AT, #sub, $CLIENT, $USERNAME, $LAST_ERROR",
            mapOf(":done" to s(STATE_DONE), ":at" to s(at.toString())),
            mapOf("#state" to STATE, "#sub" to SUB)
        )

    private suspend fun update(
        job: PurgeJob,
        expression: String,
        values: Map<String, AttributeValue>,
        names: Map<String, String> = emptyMap()
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(TABLE)
                .key(mapOf(JOB_KEY to s(job.jobKey)))
                .updateExpression(expression)
                .conditionExpression("attribute_exists($JOB_KEY)")
                .expressionAttributeValues(values)
                .apply { if (names.isNotEmpty()) expressionAttributeNames(names) }
                .build()
        )
        Unit
    }

    private fun toJob(item: Map<String, AttributeValue>): PurgeJob? {
        val type = item[TYPE]?.s()?.let { runCatching { PurgeJobType.valueOf(it) }.getOrNull() } ?: return null
        return PurgeJob(
            type = type,
            customerId = item[DynamoDBConstants.CUSTOMER_ID_KEY]?.s() ?: return null,
            itemId = item[ITEM_ID]?.s(),
            requestedAt = item[REQUESTED_AT]?.s()?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: Instant.EPOCH,
            stage = item[STAGE]?.n()?.toIntOrNull() ?: 0,
            attempts = item[ATTEMPTS]?.n()?.toIntOrNull() ?: 0,
            dueAt = item[DUE_AT]?.s(),
            sub = item[SUB]?.s(),
            client = item[CLIENT]?.s(),
            username = item[USERNAME]?.s(),
            parentId = item[PARENT_ID]?.s(),
            keptFileKeys = item[KEPT_FILE_KEYS]?.ss()?.toSet().orEmpty()
        )
    }

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()
    private fun n(value: Int): AttributeValue = AttributeValue.builder().n(value.toString()).build()

    companion object {
        private const val TABLE = DynamoDBConstants.PURGE_JOBS_TABLE
        private const val INDEX = DynamoDBConstants.PURGE_JOBS_PENDING_INDEX
        private const val JOB_KEY = "jobKey"
        private const val TYPE = "type"
        private const val ITEM_ID = "itemId"
        private const val SUB = "sub"
        private const val CLIENT = "client"
        private const val USERNAME = "username"
        private const val PARENT_ID = "parentId"
        private const val KEPT_FILE_KEYS = "keptFileKeys"
        private const val REQUESTED_AT = "requestedAt"
        private const val STAGE = "stage"
        private const val ATTEMPTS = "attempts"
        private const val PENDING_SHARD = "pendingShard"
        private const val PENDING = "PENDING"
        private const val DUE_AT = "dueAt"
        private const val WARNINGS = "warnings"
        private const val LAST_ERROR = "lastError"
        private const val STATE = "state"
        private const val STATE_DONE = "DONE"
        private const val COMPLETED_AT = "completedAt"
        private const val MAX_ERROR_CHARS = 500

        /** "ACCOUNT#{customerId}", or "{TYPE}#{customerId}#{itemId}" for one conversation or note. */
        fun jobKey(type: PurgeJobType, customerId: String, itemId: String? = null): String =
            if (itemId == null) "${type.name}#$customerId" else "${type.name}#$customerId#$itemId"
    }
}
