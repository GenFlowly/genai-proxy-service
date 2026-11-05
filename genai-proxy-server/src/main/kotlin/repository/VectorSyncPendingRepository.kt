package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.VECTOR_SYNC_DUE_AT_KEY
import com.genflowly.DynamoDBConstants.VECTOR_SYNC_ITEM_KEY
import com.genflowly.DynamoDBConstants.VECTOR_SYNC_RETRY_SHARD_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.ReturnValue
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * The data types tracked while not in the vector DB; [token] is the sort-key
 * prefix and matches the search API's type names. The encoding-server store
 * step deletes conversation and notes rows by the same keys
 * (encoding-server handlers/vector_sync_pending.py).
 */
enum class PendingVectorType(val token: String) {
    CONVERSATION("conversation"),
    NOTE("notes"),
    MEMORY("memory");

    companion object {
        fun fromToken(token: String): PendingVectorType? = entries.firstOrNull { it.token == token }
    }
}

/**
 * One record not (yet) in the vector DB. [key] is the record's id: the
 * assistant message id for a conversation exchange (with [conversationId]),
 * the noteKey, or the memoryId.
 */
data class PendingVectorItem(
    val customerId: String,
    val type: PendingVectorType,
    val key: String,
    val conversationId: String?,
    val pendingSince: String,
    val attempts: Int,
    val dueAt: String?
)

/** Data access for the VectorSyncPending table. */
class VectorSyncPendingRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /**
     * Records [key] as not in the vector DB, replacing any earlier row for it
     * (a re-save restarts the clock and the attempt count). With [retryAt] the
     * row is also scheduled for an embed retry at that time.
     */
    suspend fun markPending(
        customerId: String,
        type: PendingVectorType,
        key: String,
        conversationId: String? = null,
        retryAt: Instant? = null
    ) = withContext(Dispatchers.IO) {
        val item = mutableMapOf(
            CUSTOMER_ID_KEY to s(customerId),
            VECTOR_SYNC_ITEM_KEY to s(itemKey(type, key)),
            "type" to s(type.token),
            "key" to s(key),
            "pendingSince" to s(Instant.now().toString()),
            "attempts" to AttributeValue.builder().n("0").build()
        )
        conversationId?.let { item["conversationId"] = s(it) }
        retryAt?.let {
            item[VECTOR_SYNC_RETRY_SHARD_KEY] = s(DynamoDBConstants.VECTOR_SYNC_RETRY_SHARD_VALUE)
            item[VECTOR_SYNC_DUE_AT_KEY] = s(it.toString())
        }
        dynamoDbClient.putItem(
            PutItemRequest.builder()
                .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                .item(item)
                .build()
        )
    }

    /** The record is in the vector DB (or gone): forget it. Idempotent. */
    suspend fun clear(customerId: String, type: PendingVectorType, key: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                .key(rowKey(customerId, type, key))
                .build()
        )
    }

    /** Up to [limit] of the customer's records of [type] not in the vector DB. */
    suspend fun listPending(customerId: String, type: PendingVectorType, limit: Int): List<PendingVectorItem> =
        withContext(Dispatchers.IO) {
            val items = mutableListOf<Map<String, AttributeValue>>()
            var exclusiveStartKey: Map<String, AttributeValue>? = null
            do {
                val builder = QueryRequest.builder()
                    .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                    .keyConditionExpression("$CUSTOMER_ID_KEY = :cid AND begins_with($VECTOR_SYNC_ITEM_KEY, :prefix)")
                    .expressionAttributeValues(
                        mapOf(":cid" to s(customerId), ":prefix" to s("${type.token}#"))
                    )
                    .limit(limit - items.size)
                if (!exclusiveStartKey.isNullOrEmpty()) builder.exclusiveStartKey(exclusiveStartKey)
                val response = dynamoDbClient.query(builder.build())
                items.addAll(response.items())
                exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
            } while (!exclusiveStartKey.isNullOrEmpty() && items.size < limit)
            items.mapNotNull(::toItem)
        }

    /** Rows whose retry is due at or before [now], oldest first, across all customers. */
    suspend fun dueRetries(now: Instant, limit: Int): List<PendingVectorItem> = withContext(Dispatchers.IO) {
        dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                .indexName(DynamoDBConstants.VECTOR_SYNC_RETRY_INDEX)
                .keyConditionExpression("$VECTOR_SYNC_RETRY_SHARD_KEY = :shard AND $VECTOR_SYNC_DUE_AT_KEY <= :now")
                .expressionAttributeValues(
                    mapOf(
                        ":shard" to s(DynamoDBConstants.VECTOR_SYNC_RETRY_SHARD_VALUE),
                        ":now" to s(now.toString())
                    )
                )
                .limit(limit)
                .build()
        ).items().mapNotNull(::toItem)
    }

    /**
     * Claims the next attempt: bumps attempts and pushes dueAt out by
     * [nextRetryDelaySeconds] BEFORE the attempt runs, so a crash mid-attempt
     * re-dispatches later instead of hot-looping. Returns the new attempt
     * count, or null when the row is gone or no longer scheduled (stored or
     * claimed meanwhile).
     */
    suspend fun startAttempt(item: PendingVectorItem, nextRetryDelaySeconds: Long): Int? =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.updateItem(
                    UpdateItemRequest.builder()
                        .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                        .key(rowKey(item.customerId, item.type, item.key))
                        .updateExpression(
                            "SET attempts = if_not_exists(attempts, :zero) + :one, $VECTOR_SYNC_DUE_AT_KEY = :due"
                        )
                        .conditionExpression(
                            "attribute_exists($VECTOR_SYNC_RETRY_SHARD_KEY) AND $VECTOR_SYNC_DUE_AT_KEY = :seen"
                        )
                        .expressionAttributeValues(
                            mapOf(
                                ":zero" to AttributeValue.builder().n("0").build(),
                                ":one" to AttributeValue.builder().n("1").build(),
                                ":due" to s(Instant.now().plusSeconds(nextRetryDelaySeconds).toString()),
                                ":seen" to s(item.dueAt ?: "")
                            )
                        )
                        .returnValues(ReturnValue.UPDATED_NEW)
                        .build()
                ).attributes()?.get("attempts")?.n()?.toIntOrNull()
            } catch (e: ConditionalCheckFailedException) {
                null
            }
        }

    /**
     * Stops retrying but keeps the row, so the record stays findable by
     * keyword search. No-op when the row is gone.
     */
    suspend fun stopRetrying(item: PendingVectorItem) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
                    .key(rowKey(item.customerId, item.type, item.key))
                    .updateExpression("REMOVE $VECTOR_SYNC_RETRY_SHARD_KEY, $VECTOR_SYNC_DUE_AT_KEY")
                    .conditionExpression("attribute_exists($VECTOR_SYNC_ITEM_KEY)")
                    .build()
            )
        } catch (e: ConditionalCheckFailedException) {
            logger.debug { "Pending row for ${item.type.token} ${item.key} already gone" }
        }
    }

    private fun toItem(row: Map<String, AttributeValue>): PendingVectorItem? {
        val type = row["type"]?.s()?.let(PendingVectorType::fromToken) ?: return null
        return PendingVectorItem(
            customerId = row[CUSTOMER_ID_KEY]?.s() ?: return null,
            type = type,
            key = row["key"]?.s() ?: return null,
            conversationId = row["conversationId"]?.s(),
            pendingSince = row["pendingSince"]?.s() ?: "",
            attempts = row["attempts"]?.n()?.toIntOrNull() ?: 0,
            dueAt = row[VECTOR_SYNC_DUE_AT_KEY]?.s()
        )
    }

    private fun rowKey(customerId: String, type: PendingVectorType, key: String) = mapOf(
        CUSTOMER_ID_KEY to s(customerId),
        VECTOR_SYNC_ITEM_KEY to s(itemKey(type, key))
    )

    private fun itemKey(type: PendingVectorType, key: String) = "${type.token}#$key"

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()
}
