package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.MEMORY_CHANGE_PREFIX
import com.genflowly.DynamoDBConstants.MEMORY_CONV_META_PREFIX
import com.genflowly.DynamoDBConstants.MEMORY_ID_KEY
import com.genflowly.DynamoDBConstants.MEMORY_ITEM_PREFIX
import com.genflowly.DynamoDBConstants.MEMORY_PROFILE_PLACEMENT
import com.genflowly.DynamoDBConstants.MEMORY_USAGE_PREFIX
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryChange
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.api.MemoryUsage
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.Put
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import software.amazon.awssdk.services.dynamodb.model.Update
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/** What caused a change, as recorded on its change-log row. */
data class MemoryChangeCause(
    val type: MemoryChangeType,
    val sourceType: MemorySourceType? = null,
    val conversationId: String? = null,
    val messageId: String? = null,
    val noteKey: String? = null,
    val reason: String? = null,
)

/**
 * Data access for the CustomerMemory table. Memory items live under the
 * "MEM#" sort-key prefix; per-conversation extraction bookkeeping lives under
 * "META#CONV#" and is invisible to listings (key-condition prefix, not a
 * filter, so listing cost stays proportional to real memories).
 *
 * Every change to a memory is one transaction: the memory row and an
 * immutable change-log row written together. Writes are conditioned on the
 * row's write counter (or, for text edits, its version), so a change based
 * on a stale read is refused instead of overwriting a newer one.
 */
class MemoryRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /** Creates a memory as version 1, with the change-log entry that says why. */
    suspend fun createMemory(
        customerId: String,
        text: String,
        placements: List<MemoryPlacement>,
        category: String?,
        sourceType: MemorySourceType,
        sourceId: String?,
        cause: MemoryChangeCause,
    ): CustomerMemory = withContext(Dispatchers.IO) {
        require(placements.isNotEmpty()) { "A memory must apply somewhere" }
        val now = Instant.now().toString()
        val ordered = ordered(placements)
        val memory = CustomerMemory(
            memoryId = "$MEMORY_ITEM_PREFIX${UUID.randomUUID()}",
            text = text,
            kind = ordered.first().kind,
            category = category,
            sourceType = sourceType,
            sourceId = sourceId,
            createdAt = now,
            updatedAt = now,
            placements = ordered,
            version = 1,
            tracked = true,
            rev = 1,
        )
        val item = mutableMapOf(
            CUSTOMER_ID_KEY to s(customerId),
            MEMORY_ID_KEY to s(memory.memoryId),
            "text" to s(memory.text),
            "kind" to s(memory.kind.name),
            "sourceType" to s(memory.sourceType.name),
            "createdAt" to s(now),
            "updatedAt" to s(now),
            PLACEMENTS to placementsValue(ordered),
            VERSION to n(1),
            REV to n(1),
        )
        memory.category?.let { item["category"] = s(it) }
        memory.sourceId?.let { item["sourceId"] = s(it) }

        dynamoDbClient.transactWriteItems(
            TransactWriteItemsRequest.builder().transactItems(
                TransactWriteItem.builder().put(
                    Put.builder()
                        .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                        .item(item)
                        .conditionExpression("attribute_not_exists($MEMORY_ID_KEY)")
                        .build()
                ).build(),
                changePut(customerId, memory.memoryId, now, cause, version = 1, text = text),
            ).build()
        )
        logger.info { "Created memory ${memory.memoryId} for customer $customerId" }
        memory
    }

    /**
     * Saves [text] as the next version of [memory] (as read). Returns false
     * when the memory is gone or a newer version was saved since it was read.
     */
    suspend fun updateMemoryText(
        customerId: String,
        memory: CustomerMemory,
        text: String,
        cause: MemoryChangeCause,
    ): Boolean = withContext(Dispatchers.IO) {
        val now = Instant.now().toString()
        val newVersion = memory.version + 1
        val condition = if (memory.tracked) "#version = :base"
            else "attribute_exists($MEMORY_ID_KEY) AND attribute_not_exists(#version)"
        val values = mutableMapOf(
            ":text" to s(text), ":nv" to n(newVersion), ":now" to s(now), ":zero" to n(0), ":one" to n(1)
        )
        if (memory.tracked) values[":base"] = n(memory.version)
        val update = Update.builder()
            .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
            .key(memoryKey(customerId, memory.memoryId))
            .updateExpression(
                "SET #text = :text, #version = :nv, #updatedAt = :now, #rev = if_not_exists(#rev, :zero) + :one"
            )
            .conditionExpression(condition)
            .expressionAttributeNames(
                mapOf("#text" to "text", "#version" to VERSION, "#updatedAt" to "updatedAt", "#rev" to REV)
            )
            .expressionAttributeValues(values)
            .build()
        transact(
            buildList {
                if (!memory.tracked) add(legacyBaselinePut(customerId, memory))
                add(TransactWriteItem.builder().update(update).build())
                add(
                    changePut(
                        customerId, memory.memoryId, now, cause,
                        version = newVersion, text = text, previousText = memory.text
                    )
                )
            },
            "update text of ${memory.memoryId}"
        )
    }

    /**
     * Sets where [memory] (as read) applies, logging the move or copy.
     * Returns false when it is gone or changed since it was read.
     */
    suspend fun setPlacements(
        customerId: String,
        memory: CustomerMemory,
        placements: List<MemoryPlacement>,
        cause: MemoryChangeCause,
        from: List<MemoryPlacement>,
        to: List<MemoryPlacement>,
    ): Boolean = withContext(Dispatchers.IO) {
        require(placements.isNotEmpty()) { "A memory must apply somewhere" }
        val now = Instant.now().toString()
        val ordered = ordered(placements)
        val values = mutableMapOf(
            ":p" to placementsValue(ordered),
            ":k" to s(ordered.first().kind.name),
            ":nrev" to n(memory.rev + 1),
            ":now" to s(now),
        )
        val revCondition = if (memory.rev == 0L) {
            "attribute_not_exists(#rev)"
        } else {
            values[":rev"] = n(memory.rev)
            "#rev = :rev"
        }
        val names = mutableMapOf(
            "#placements" to PLACEMENTS, "#kind" to "kind", "#rev" to REV, "#updatedAt" to "updatedAt"
        )
        var expression = "SET #placements = :p, #kind = :k, #rev = :nrev, #updatedAt = :now"
        if (!memory.tracked) {
            expression += ", #version = :one"
            names["#version"] = VERSION
            values[":one"] = n(1)
        }
        val update = Update.builder()
            .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
            .key(memoryKey(customerId, memory.memoryId))
            .updateExpression(expression)
            .conditionExpression("attribute_exists($MEMORY_ID_KEY) AND $revCondition")
            .expressionAttributeNames(names)
            .expressionAttributeValues(values)
            .build()
        transact(
            buildList {
                if (!memory.tracked) add(legacyBaselinePut(customerId, memory))
                add(TransactWriteItem.builder().update(update).build())
                add(changePut(customerId, memory.memoryId, now, cause, from = from, to = to))
            },
            "set placements of ${memory.memoryId}"
        )
    }

    /** The memory's change log, oldest first. */
    suspend fun getChanges(customerId: String, memoryId: String): List<MemoryChange> =
        withContext(Dispatchers.IO) {
            queryPrefix(customerId, "$MEMORY_CHANGE_PREFIX${uuidOf(memoryId)}#").mapNotNull { itemToChange(it) }
        }

    /**
     * One page of the memory's usage log, newest first, and the cursor of the
     * next page (null on the last one).
     */
    suspend fun getUsagePage(
        customerId: String,
        memoryId: String,
        limit: Int,
        cursor: String?,
    ): Pair<List<MemoryUsage>, String?> = withContext(Dispatchers.IO) {
        val prefix = "$MEMORY_USAGE_PREFIX${uuidOf(memoryId)}#"
        val builder = QueryRequest.builder()
            .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
            .keyConditionExpression("$CUSTOMER_ID_KEY = :cid AND begins_with($MEMORY_ID_KEY, :prefix)")
            .expressionAttributeValues(mapOf(":cid" to s(customerId), ":prefix" to s(prefix)))
            .scanIndexForward(false)
            .limit(limit)
        decodeCursor(cursor)?.takeIf { it.startsWith(prefix) }?.let {
            builder.exclusiveStartKey(memoryKey(customerId, it))
        }
        val response = dynamoDbClient.query(builder.build())
        val next = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey()[MEMORY_ID_KEY]?.s() else null
        response.items().mapNotNull { itemToUsage(it) } to next?.let { encodeCursor(it) }
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

    /** Runs the transaction; false when one of its conditions failed. */
    private fun transact(items: List<TransactWriteItem>, what: String): Boolean = try {
        dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(items).build())
        true
    } catch (e: TransactionCanceledException) {
        if (e.cancellationReasons().any { it.code() == "ConditionalCheckFailed" }) {
            logger.info { "Refused to $what: changed or deleted since it was read" }
            false
        } else {
            throw e
        }
    }

    private fun changePut(
        customerId: String,
        memoryId: String,
        createdAt: String,
        cause: MemoryChangeCause,
        version: Int? = null,
        text: String? = null,
        previousText: String? = null,
        from: List<MemoryPlacement>? = null,
        to: List<MemoryPlacement>? = null,
        suffix: String = UUID.randomUUID().toString().take(8),
    ): TransactWriteItem {
        val item = mutableMapOf(
            CUSTOMER_ID_KEY to s(customerId),
            MEMORY_ID_KEY to s("$MEMORY_CHANGE_PREFIX${uuidOf(memoryId)}#$createdAt#$suffix"),
            CHANGE_TYPE to s(cause.type.name),
            "createdAt" to s(createdAt),
        )
        version?.let { item[VERSION] = n(it) }
        text?.let { item["text"] = s(it) }
        previousText?.let { item["previousText"] = s(it) }
        cause.sourceType?.let { item["sourceType"] = s(it.name) }
        cause.conversationId?.let { item["conversationId"] = s(it) }
        cause.messageId?.let { item["messageId"] = s(it) }
        cause.noteKey?.let { item["noteKey"] = s(it) }
        cause.reason?.takeIf { it.isNotBlank() }?.let { item["reason"] = s(it) }
        from?.let { item[FROM_PLACEMENTS] = placementsValue(it) }
        to?.let { item[TO_PLACEMENTS] = placementsValue(it) }
        return TransactWriteItem.builder().put(
            Put.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .item(item)
                .conditionExpression("attribute_not_exists($MEMORY_ID_KEY)")
                .build()
        ).build()
    }

    /**
     * Version 1 of a memory stored before versions were recorded: its text as
     * it is now, written with its first recorded change. The fixed key makes
     * a second, racing baseline fail instead of duplicating it.
     */
    private fun legacyBaselinePut(customerId: String, memory: CustomerMemory): TransactWriteItem =
        changePut(
            customerId, memory.memoryId, memory.createdAt.ifBlank { EPOCH },
            MemoryChangeCause(
                type = MemoryChangeType.LEGACY,
                sourceType = memory.sourceType,
                conversationId = memory.sourceId.takeIf { memory.sourceType == MemorySourceType.CONVERSATION },
                noteKey = memory.sourceId.takeIf { memory.sourceType == MemorySourceType.NOTE },
            ),
            version = 1,
            text = memory.text,
            suffix = BASELINE_SUFFIX,
        )

    private fun queryPrefix(customerId: String, prefix: String): List<Map<String, AttributeValue>> =
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .keyConditionExpression("$CUSTOMER_ID_KEY = :cid AND begins_with($MEMORY_ID_KEY, :prefix)")
                .expressionAttributeValues(mapOf(":cid" to s(customerId), ":prefix" to s(prefix)))
                .build()
        ).items().toList()

    private fun itemToMemory(item: Map<String, AttributeValue>): CustomerMemory? {
        val memoryId = item[MEMORY_ID_KEY]?.s() ?: return null
        val text = item["text"]?.s() ?: return null
        val kind = item["kind"]?.s()?.let { runCatching { MemoryKind.valueOf(it) }.getOrNull() }
            ?: MemoryKind.EPISODIC
        val placements = item[PLACEMENTS]?.m()?.let { parsePlacements(it) }.orEmpty()
            .ifEmpty { listOf(MemoryPlacement(projectId = null, kind = kind)) }
        return CustomerMemory(
            memoryId = memoryId,
            text = text,
            kind = placements.first().kind,
            category = item["category"]?.s(),
            sourceType = item["sourceType"]?.s()
                ?.let { runCatching { MemorySourceType.valueOf(it) }.getOrNull() }
                ?: MemorySourceType.CONVERSATION,
            sourceId = item["sourceId"]?.s(),
            createdAt = item["createdAt"]?.s() ?: "",
            updatedAt = item["updatedAt"]?.s() ?: "",
            placements = placements,
            version = item[VERSION]?.n()?.toIntOrNull() ?: 1,
            tracked = item.containsKey(VERSION),
            hitCount = item[HIT_COUNT]?.n()?.toLongOrNull() ?: 0,
            lastUsedAt = item[LAST_USED_AT]?.s(),
            rev = item[REV]?.n()?.toLongOrNull() ?: 0,
        )
    }

    private fun itemToChange(item: Map<String, AttributeValue>): MemoryChange? {
        val changeId = item[MEMORY_ID_KEY]?.s() ?: return null
        val type = item[CHANGE_TYPE]?.s()?.let { runCatching { MemoryChangeType.valueOf(it) }.getOrNull() }
            ?: return null
        return MemoryChange(
            changeId = changeId,
            type = type,
            createdAt = item["createdAt"]?.s() ?: "",
            version = item[VERSION]?.n()?.toIntOrNull(),
            text = item["text"]?.s(),
            previousText = item["previousText"]?.s(),
            sourceType = item["sourceType"]?.s()?.let { runCatching { MemorySourceType.valueOf(it) }.getOrNull() },
            conversationId = item["conversationId"]?.s(),
            messageId = item["messageId"]?.s(),
            noteKey = item["noteKey"]?.s(),
            reason = item["reason"]?.s(),
            from = item[FROM_PLACEMENTS]?.m()?.let { parsePlacements(it) },
            to = item[TO_PLACEMENTS]?.m()?.let { parsePlacements(it) },
        )
    }

    private fun itemToUsage(item: Map<String, AttributeValue>): MemoryUsage? {
        val conversationId = item["conversationId"]?.s() ?: return null
        val messageId = item["messageId"]?.s() ?: return null
        return MemoryUsage(
            conversationId = conversationId,
            messageId = messageId,
            usedAt = item[DynamoDBConstants.MEMORY_USED_AT_KEY]?.s() ?: "",
            how = item["how"]?.s() ?: "",
        )
    }

    private fun parsePlacements(map: Map<String, AttributeValue>): List<MemoryPlacement> =
        ordered(
            map.mapNotNull { (key, value) ->
                val kind = value.s()?.let { runCatching { MemoryKind.valueOf(it) }.getOrNull() }
                    ?: return@mapNotNull null
                MemoryPlacement(projectId = key.takeUnless { it == MEMORY_PROFILE_PLACEMENT }, kind = kind)
            }
        )

    private fun placementsValue(placements: List<MemoryPlacement>): AttributeValue =
        AttributeValue.builder().m(
            placements.associate { (it.projectId ?: MEMORY_PROFILE_PLACEMENT) to s(it.kind.name) }
        ).build()

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()

    private fun n(value: Number): AttributeValue = AttributeValue.builder().n(value.toString()).build()

    private companion object {
        const val PLACEMENTS = "placements"
        const val VERSION = "version"
        const val REV = "rev"
        const val HIT_COUNT = DynamoDBConstants.MEMORY_HIT_COUNT_KEY
        const val LAST_USED_AT = DynamoDBConstants.MEMORY_LAST_USED_AT_KEY
        const val CHANGE_TYPE = "changeType"
        const val FROM_PLACEMENTS = "fromPlacements"
        const val TO_PLACEMENTS = "toPlacements"
        const val BASELINE_SUFFIX = "base"
        const val EPOCH = "1970-01-01T00:00:00Z"

        fun uuidOf(memoryId: String) = memoryId.removePrefix(MEMORY_ITEM_PREFIX)

        /** Profile first, then projects by id: stable, and the first one gives [CustomerMemory.kind]. */
        fun ordered(placements: List<MemoryPlacement>): List<MemoryPlacement> =
            placements.distinctBy { it.projectId }.sortedWith(compareBy({ it.projectId != null }, { it.projectId }))

        fun encodeCursor(sortKey: String): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(sortKey.toByteArray())

        fun decodeCursor(cursor: String?): String? =
            cursor?.let { runCatching { String(Base64.getUrlDecoder().decode(it)) }.getOrNull() }
    }
}
