package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.MEMORY_CONV_META_PREFIX
import com.genflowly.DynamoDBConstants.MEMORY_ID_KEY
import com.genflowly.DynamoDBConstants.MEMORY_ITEM_PREFIX
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the CustomerMemory table. Memory items live under the
 * "MEM#" sort-key prefix; per-conversation extraction bookkeeping lives under
 * "META#CONV#" and is invisible to listings (key-condition prefix, not a
 * filter, so listing cost stays proportional to real memories).
 */
class MemoryRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun createMemory(
        customerId: String,
        text: String,
        kind: MemoryKind,
        category: String?,
        sourceType: MemorySourceType,
        sourceId: String?
    ): CustomerMemory = withContext(Dispatchers.IO) {
        val now = Instant.now().toString()
        val memory = CustomerMemory(
            memoryId = "$MEMORY_ITEM_PREFIX${UUID.randomUUID()}",
            text = text,
            kind = kind,
            category = category,
            sourceType = sourceType,
            sourceId = sourceId,
            createdAt = now,
            updatedAt = now
        )
        val item = mutableMapOf(
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            MEMORY_ID_KEY to AttributeValue.builder().s(memory.memoryId).build(),
            "text" to AttributeValue.builder().s(memory.text).build(),
            "kind" to AttributeValue.builder().s(memory.kind.name).build(),
            "sourceType" to AttributeValue.builder().s(memory.sourceType.name).build(),
            "createdAt" to AttributeValue.builder().s(now).build(),
            "updatedAt" to AttributeValue.builder().s(now).build()
        )
        memory.category?.let { item["category"] = AttributeValue.builder().s(it).build() }
        memory.sourceId?.let { item["sourceId"] = AttributeValue.builder().s(it).build() }

        dynamoDbClient.putItem(
            PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .item(item)
                .build()
        )
        logger.info { "Created memory ${memory.memoryId} for customer $customerId" }
        memory
    }

    /** Rewrites a memory's text. Returns false when the memory no longer exists. */
    suspend fun updateMemoryText(
        customerId: String,
        memoryId: String,
        text: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, memoryId))
                    .updateExpression("SET #text = :text, #updatedAt = :now")
                    .conditionExpression("attribute_exists($MEMORY_ID_KEY)")
                    .expressionAttributeNames(mapOf("#text" to "text", "#updatedAt" to "updatedAt"))
                    .expressionAttributeValues(
                        mapOf(
                            ":text" to AttributeValue.builder().s(text).build(),
                            ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                        )
                    )
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            logger.warn { "Skipped update of missing memory $memoryId for $customerId" }
            false
        }
    }

    /** Hard delete — memories are user-visible learned data, kept only while wanted. */
    suspend fun deleteMemory(customerId: String, memoryId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.deleteItem(
                DeleteItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, memoryId))
                    .conditionExpression("attribute_exists($MEMORY_ID_KEY)")
                    .build()
            )
            logger.info { "Deleted memory $memoryId for customer $customerId" }
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun getMemory(customerId: String, memoryId: String): CustomerMemory? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .key(memoryKey(customerId, memoryId))
                .build()
        )
        if (response.hasItem() && response.item().isNotEmpty()) itemToMemory(response.item()) else null
    }

    suspend fun getMemories(customerId: String): List<CustomerMemory> = withContext(Dispatchers.IO) {
        val items = mutableListOf<Map<String, AttributeValue>>()
        var exclusiveStartKey: Map<String, AttributeValue>? = null
        do {
            val builder = QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .keyConditionExpression("$CUSTOMER_ID_KEY = :cid AND begins_with($MEMORY_ID_KEY, :prefix)")
                .expressionAttributeValues(
                    mapOf(
                        ":cid" to AttributeValue.builder().s(customerId).build(),
                        ":prefix" to AttributeValue.builder().s(MEMORY_ITEM_PREFIX).build()
                    )
                )
            if (!exclusiveStartKey.isNullOrEmpty()) {
                builder.exclusiveStartKey(exclusiveStartKey)
            }
            val response = dynamoDbClient.query(builder.build())
            items.addAll(response.items())
            exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
        } while (!exclusiveStartKey.isNullOrEmpty())

        items.mapNotNull { itemToMemory(it) }
    }

    /**
     * The conversation's extraction mark. [processed] is the message count at
     * the last claim; [claimedFrom]/[claimedAt] are present only while a claim
     * is UNFINALIZED (an extraction is running — or died mid-run): claimedFrom
     * is the pre-claim count (-1 = the conversation had never been processed),
     * letting the reconciler roll a stale claim back after a crash.
     */
    data class ExtractionMark(
        val processed: Int?,
        val claimedFrom: Int?,
        val claimedAt: Instant?,
    )

    suspend fun getExtractionMark(
        customerId: String,
        conversationId: String
    ): ExtractionMark? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .key(memoryKey(customerId, "$MEMORY_CONV_META_PREFIX$conversationId"))
                .build()
        )
        val item = response.item()
        if (item.isNullOrEmpty()) return@withContext null
        ExtractionMark(
            processed = item["processedMessageCount"]?.n()?.toIntOrNull(),
            claimedFrom = item["claimedFrom"]?.n()?.toIntOrNull(),
            claimedAt = item["claimedAt"]?.s()?.let { runCatching { Instant.parse(it) }.getOrNull() },
        )
    }

    /**
     * Atomically CLAIM the extraction window [fromCount → toCount]: succeeds
     * only when the mark still reads [fromCount] (null = never processed), so
     * exactly one of several concurrent triggers (parallel vendors, reconciler
     * racing a live run) extracts a given window. Returns false when the claim
     * was lost. The claim records claimedFrom/claimedAt until
     * [finalizeConversationExtraction] (success) or
     * [rollbackConversationExtractionMark] (failure) resolves it — a claim
     * left unfinalized is a crashed run, recoverable by the reconciler.
     */
    suspend fun claimConversationExtraction(
        customerId: String,
        conversationId: String,
        fromCount: Int?,
        toCount: Int
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val values = mutableMapOf(
                ":to" to AttributeValue.builder().n(toCount.toString()).build(),
                ":cf" to AttributeValue.builder().n((fromCount ?: -1).toString()).build(),
                ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
            )
            val condition = if (fromCount == null) {
                "attribute_not_exists(processedMessageCount)"
            } else {
                values[":from"] = AttributeValue.builder().n(fromCount.toString()).build()
                "processedMessageCount = :from"
            }
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, "$MEMORY_CONV_META_PREFIX$conversationId"))
                    .updateExpression(
                        "SET processedMessageCount = :to, claimedFrom = :cf, claimedAt = :now, updatedAt = :now"
                    )
                    .conditionExpression(condition)
                    .expressionAttributeValues(values)
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    /** Settle a successful run's claim: the mark keeps [toCount], the claim markers go. */
    suspend fun finalizeConversationExtraction(
        customerId: String,
        conversationId: String,
        toCount: Int
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, "$MEMORY_CONV_META_PREFIX$conversationId"))
                    .updateExpression("REMOVE claimedFrom, claimedAt SET updatedAt = :now")
                    .conditionExpression("processedMessageCount = :to")
                    .expressionAttributeValues(
                        mapOf(
                            ":to" to AttributeValue.builder().n(toCount.toString()).build(),
                            ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                        )
                    )
                    .build()
            )
        } catch (e: ConditionalCheckFailedException) {
            // Mark moved since our claim — the newer claim owns the markers.
        }
    }

    /**
     * Release a claimed window after a failed run — but only OUR claim: the
     * mark is restored to [fromCount] solely while it still reads [toCount],
     * so a later successful claim is never clobbered. fromCount == null (the
     * conversation had never been processed) removes the mark item entirely.
     */
    suspend fun rollbackConversationExtractionMark(
        customerId: String,
        conversationId: String,
        fromCount: Int?,
        toCount: Int
    ) = withContext(Dispatchers.IO) {
        val key = memoryKey(customerId, "$MEMORY_CONV_META_PREFIX$conversationId")
        val toValue = AttributeValue.builder().n(toCount.toString()).build()
        try {
            if (fromCount == null) {
                dynamoDbClient.deleteItem(
                    DeleteItemRequest.builder()
                        .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                        .key(key)
                        .conditionExpression("processedMessageCount = :to")
                        .expressionAttributeValues(mapOf(":to" to toValue))
                        .build()
                )
            } else {
                dynamoDbClient.updateItem(
                    UpdateItemRequest.builder()
                        .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                        .key(key)
                        .updateExpression(
                            "SET processedMessageCount = :from, updatedAt = :now REMOVE claimedFrom, claimedAt"
                        )
                        .conditionExpression("processedMessageCount = :to")
                        .expressionAttributeValues(
                            mapOf(
                                ":from" to AttributeValue.builder().n(fromCount.toString()).build(),
                                ":to" to toValue,
                                ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                            )
                        )
                        .build()
                )
            }
            logger.info { "Rolled extraction mark for $conversationId back to $fromCount (window $toCount released)" }
        } catch (e: ConditionalCheckFailedException) {
            // Someone else advanced the mark since our claim — theirs wins.
        }
    }

    // ── Pending-extraction work queue ────────────────────────────────────────
    //
    // One "META#PENDING#<conversationId>" row per conversation with extraction
    // work outstanding, written BEFORE the in-process run starts and deleted on
    // every terminal outcome — so a crash/restart (or a retryable failure)
    // leaves a due row behind for the reconciler instead of silently losing
    // the work. The sparse GSI (pendingShard const / dueAt) is the queue view.

    data class PendingExtraction(
        val customerId: String,
        val conversationId: String,
        val dueAt: String,
        val attempts: Int,
        val responseMessageId: String?,
    )

    /**
     * Upsert the pending row with a new due time. `attempts` survives the
     * upsert (a retry reschedule must not reset the give-up counter).
     */
    suspend fun putPendingExtraction(
        customerId: String,
        conversationId: String,
        dueAt: Instant,
        responseMessageId: String?
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .key(memoryKey(customerId, "${DynamoDBConstants.MEMORY_PENDING_PREFIX}$conversationId"))
                .updateExpression(
                    "SET ${DynamoDBConstants.MEMORY_PENDING_SHARD_KEY} = :shard, " +
                            "${DynamoDBConstants.MEMORY_PENDING_DUE_AT_KEY} = :due, " +
                            "responseMessageId = :rmid, updatedAt = :now, " +
                            "attempts = if_not_exists(attempts, :zero)"
                )
                .expressionAttributeValues(
                    mapOf(
                        ":shard" to AttributeValue.builder().s(DynamoDBConstants.MEMORY_PENDING_SHARD_VALUE).build(),
                        ":due" to AttributeValue.builder().s(dueAt.toString()).build(),
                        ":rmid" to AttributeValue.builder().s(responseMessageId ?: "").build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build(),
                        ":zero" to AttributeValue.builder().n("0").build()
                    )
                )
                .build()
        )
    }

    suspend fun deletePendingExtraction(customerId: String, conversationId: String) =
        withContext(Dispatchers.IO) {
            dynamoDbClient.deleteItem(
                DeleteItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, "${DynamoDBConstants.MEMORY_PENDING_PREFIX}$conversationId"))
                    .build()
            )
        }

    /**
     * Bump the attempt counter and push dueAt out by [retryDelaySeconds] (so a
     * crashed attempt re-dispatches later instead of hot-looping). Returns the
     * new attempt count, or null when the row no longer exists (a concurrent
     * run completed and deleted it).
     */
    suspend fun startPendingAttempt(
        customerId: String,
        conversationId: String,
        retryDelaySeconds: Long
    ): Int? = withContext(Dispatchers.IO) {
        try {
            val response = dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .key(memoryKey(customerId, "${DynamoDBConstants.MEMORY_PENDING_PREFIX}$conversationId"))
                    .updateExpression(
                        "SET attempts = if_not_exists(attempts, :zero) + :one, " +
                                "${DynamoDBConstants.MEMORY_PENDING_DUE_AT_KEY} = :due, updatedAt = :now"
                    )
                    .conditionExpression("attribute_exists($MEMORY_ID_KEY)")
                    .expressionAttributeValues(
                        mapOf(
                            ":zero" to AttributeValue.builder().n("0").build(),
                            ":one" to AttributeValue.builder().n("1").build(),
                            ":due" to AttributeValue.builder()
                                .s(Instant.now().plusSeconds(retryDelaySeconds).toString()).build(),
                            ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                        )
                    )
                    .returnValues(software.amazon.awssdk.services.dynamodb.model.ReturnValue.UPDATED_NEW)
                    .build()
            )
            response.attributes()?.get("attempts")?.n()?.toIntOrNull()
        } catch (e: ConditionalCheckFailedException) {
            null
        }
    }

    /** Pending rows due at or before [now], oldest first, across ALL customers. */
    suspend fun duePendingExtractions(now: Instant, limit: Int): List<PendingExtraction> =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .indexName(DynamoDBConstants.MEMORY_PENDING_INDEX)
                    .keyConditionExpression(
                        "${DynamoDBConstants.MEMORY_PENDING_SHARD_KEY} = :shard AND " +
                                "${DynamoDBConstants.MEMORY_PENDING_DUE_AT_KEY} <= :now"
                    )
                    .expressionAttributeValues(
                        mapOf(
                            ":shard" to AttributeValue.builder().s(DynamoDBConstants.MEMORY_PENDING_SHARD_VALUE).build(),
                            ":now" to AttributeValue.builder().s(now.toString()).build()
                        )
                    )
                    .limit(limit)
                    .build()
            )
            response.items().mapNotNull { item ->
                val memoryId = item[MEMORY_ID_KEY]?.s() ?: return@mapNotNull null
                PendingExtraction(
                    customerId = item[CUSTOMER_ID_KEY]?.s() ?: return@mapNotNull null,
                    conversationId = memoryId.removePrefix(DynamoDBConstants.MEMORY_PENDING_PREFIX),
                    dueAt = item[DynamoDBConstants.MEMORY_PENDING_DUE_AT_KEY]?.s() ?: "",
                    attempts = item["attempts"]?.n()?.toIntOrNull() ?: 0,
                    responseMessageId = item["responseMessageId"]?.s()?.takeIf { it.isNotBlank() },
                )
            }
        }

    private fun memoryKey(customerId: String, memoryId: String) = mapOf(
        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
        MEMORY_ID_KEY to AttributeValue.builder().s(memoryId).build()
    )

    private fun itemToMemory(item: Map<String, AttributeValue>): CustomerMemory? {
        val memoryId = item[MEMORY_ID_KEY]?.s() ?: return null
        val text = item["text"]?.s() ?: return null
        return CustomerMemory(
            memoryId = memoryId,
            text = text,
            kind = item["kind"]?.s()?.let { runCatching { MemoryKind.valueOf(it) }.getOrNull() }
                ?: MemoryKind.EPISODIC,
            category = item["category"]?.s(),
            sourceType = item["sourceType"]?.s()
                ?.let { runCatching { MemorySourceType.valueOf(it) }.getOrNull() }
                ?: MemorySourceType.CONVERSATION,
            sourceId = item["sourceId"]?.s(),
            createdAt = item["createdAt"]?.s() ?: "",
            updatedAt = item["updatedAt"]?.s() ?: ""
        )
    }
}
