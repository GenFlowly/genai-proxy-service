package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CONTENT_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_GSI_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_ID_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_NAME_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_TABLE
import com.genflowly.DynamoDBConstants.INSTRUCTION_VERSION_KEY
import java.util.concurrent.ConcurrentHashMap
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
 * Data access for the Instructions, InstructionUsage and InstructionUsageSeen
 * tables. Instruction (id, version) rows are immutable, which is what makes
 * the read-through item cache here safe (no invalidation needed).
 */
class InstructionRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {
    // Instruction content cache. A given (id, version) is IMMUTABLE — editing an
    // instruction creates a new version — so cached content never goes stale and
    // needs no invalidation. Positive-only (misses are not cached). Soft-capped.
    private val instructionCache = ConcurrentHashMap<String, com.genflowly.models.Instruction>()
    private val INSTRUCTION_CACHE_MAX = 10_000

    suspend fun getLatestInstructionVersion(id: String): Int? =
        withContext(Dispatchers.IO) {
            // Guard: DynamoDB rejects an empty string as a key value. A blank id
            // means "no instruction selected" — treat as not-found, don't query.
            if (id.isBlank()) return@withContext null
            // Since version is Sort Key, we can Query by PK (id) with Limit 1 and ScanIndexForward false to get highest version
            val request = QueryRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .keyConditionExpression("$INSTRUCTION_ID_KEY = :id")
                .expressionAttributeValues(
                    mapOf(":id" to AttributeValue.builder().s(id).build())
                )
                .scanIndexForward(false) // Reverse order (descending version)
                .limit(1)
                .build()

            val response = dynamoDbClient.query(request)
            val item = response.items().firstOrNull() ?: return@withContext null
            item[INSTRUCTION_VERSION_KEY]?.n()?.toInt()
        }

    suspend fun getInstruction(instructionId: String, version: Int): com.genflowly.models.Instruction? =
        withContext(Dispatchers.IO) {
            // Guard: DynamoDB rejects an empty string as a key attribute value.
            // A blank instructionId means "no instruction selected" — treat as
            // not-found instead of throwing (was crashing GenerateTextStream).
            if (instructionId.isBlank()) return@withContext null

            // Serve immutable (id, version) content from cache when present.
            val cacheKey = "$instructionId#$version"
            instructionCache[cacheKey]?.let { return@withContext it }

            val key = mapOf(
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(instructionId).build(),
                INSTRUCTION_VERSION_KEY to AttributeValue.builder().n(version.toString()).build()
            )

            val request = GetItemRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            val item = response.item() ?: return@withContext null

            if (item.isEmpty()) return@withContext null

            itemToInstruction(item)?.also { instruction ->
                // Cache the immutable content (positive-only). Clear on soft-cap
                // to keep memory bounded — the working set is tiny in practice.
                if (instructionCache.size >= INSTRUCTION_CACHE_MAX) instructionCache.clear()
                instructionCache[cacheKey] = instruction
            }
        }

    suspend fun saveInstruction(instruction: com.genflowly.models.Instruction) = withContext(Dispatchers.IO) {
        try {
            val itemMap = mutableMapOf(
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(instruction.id).build(),
                INSTRUCTION_CREATOR_KEY to AttributeValue.builder().s(instruction.creator).build(),
                INSTRUCTION_NAME_KEY to AttributeValue.builder().s(instruction.name).build(),
                INSTRUCTION_CONTENT_KEY to AttributeValue.builder().s(instruction.instructions).build(),
                INSTRUCTION_VERSION_KEY to AttributeValue.builder().n(instruction.version.toString()).build()
            )

            instruction.icon?.let {
                itemMap[DynamoDBConstants.INSTRUCTION_ICON_KEY] = AttributeValue.builder().s(it).build()
            }
            instruction.color?.let {
                itemMap[DynamoDBConstants.INSTRUCTION_COLOR_KEY] = AttributeValue.builder().s(it).build()
            }
            instruction.category?.let {
                itemMap[DynamoDBConstants.INSTRUCTION_CATEGORY_KEY] = AttributeValue.builder().s(it).build()
            }
            if (!instruction.tags.isNullOrEmpty()) {
                val tagList = instruction.tags.map { AttributeValue.builder().s(it).build() }
                itemMap[DynamoDBConstants.INSTRUCTION_TAGS_KEY] = AttributeValue.builder().l(tagList).build()
            }

            val item = withTimestamps(itemMap)

            val putReq = PutItemRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved instruction ${instruction.id} v${instruction.version} for ${instruction.creator}")
        } catch (e: Exception) {
            logger.error("Failed to save instruction", e)
            throw e
        }
    }

    suspend fun getInstructionsByCreator(creatorId: String): List<com.genflowly.models.Instruction> =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .indexName(INSTRUCTION_CREATOR_GSI_KEY)
                .keyConditionExpression("$INSTRUCTION_CREATOR_KEY = :creator")
                .expressionAttributeValues(
                    mapOf(":creator" to AttributeValue.builder().s(creatorId).build())
                )
                .build()

            val response = dynamoDbClient.query(request)
            response.items().mapNotNull { itemToInstruction(it) }
        }

    /**
     * The customer's most-recently-used instruction ids ordered by lastUsedAt
     * descending, at most [limit] entries. Backs the "recently used" picker.
     */
    suspend fun getRecentlyUsedInstructionIds(customerId: String, limit: Int): List<String> =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(DynamoDBConstants.INSTRUCTION_USAGE_TABLE)
                .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()

            dynamoDbClient.query(request).items()
                .sortedByDescending { it[DynamoDBConstants.INSTRUCTION_LAST_USED_KEY]?.s() ?: "" }
                .mapNotNull { it[INSTRUCTION_ID_KEY]?.s() }
                .distinct()
                .take(limit)
        }

    suspend fun deleteInstruction(instructionId: String) = withContext(Dispatchers.IO) {
        try {
            // Get all versions of this instruction to delete them
            val request = QueryRequest.builder()
                .tableName(INSTRUCTION_TABLE)
                .keyConditionExpression("$INSTRUCTION_ID_KEY = :id")
                .expressionAttributeValues(
                    mapOf(":id" to AttributeValue.builder().s(instructionId).build())
                )
                .build()

            val response = dynamoDbClient.query(request)
            val items = response.items()

            for (item in items) {
                val version = item[INSTRUCTION_VERSION_KEY]?.n() ?: continue
                val deleteReq = DeleteItemRequest.builder()
                    .tableName(INSTRUCTION_TABLE)
                    .key(mapOf(
                        INSTRUCTION_ID_KEY to AttributeValue.builder().s(instructionId).build(),
                        INSTRUCTION_VERSION_KEY to AttributeValue.builder().n(version).build()
                    ))
                    .build()
                dynamoDbClient.deleteItem(deleteReq)
            }
            logger.info("Deleted ${items.size} versions of instruction $instructionId")
        } catch (e: Exception) {
            logger.error("Failed to delete instruction $instructionId", e)
            throw e
        }
    }

    private fun itemToInstruction(item: Map<String, AttributeValue>): com.genflowly.models.Instruction? {
        return com.genflowly.models.Instruction(
            id = item[INSTRUCTION_ID_KEY]?.s() ?: return null,
            creator = item[INSTRUCTION_CREATOR_KEY]?.s() ?: return null,
            name = item[INSTRUCTION_NAME_KEY]?.s() ?: "",
            instructions = item[INSTRUCTION_CONTENT_KEY]?.s() ?: "",
            version = item[INSTRUCTION_VERSION_KEY]?.n()?.toInt() ?: 1,
            icon = item[DynamoDBConstants.INSTRUCTION_ICON_KEY]?.s(),
            color = item[DynamoDBConstants.INSTRUCTION_COLOR_KEY]?.s(),
            category = item[DynamoDBConstants.INSTRUCTION_CATEGORY_KEY]?.s(),
            tags = item[DynamoDBConstants.INSTRUCTION_TAGS_KEY]?.l()?.mapNotNull { it.s() },
            createdAt = item["createdAt"]?.s(),
            updatedAt = item["updatedAt"]?.s(),
            syncedWithVectorDb = item["is_synced_with_milvus"]?.bool() == true
        )
    }

    // ─── Usage tracking ───────────────────────────────────────────────────────

    /**
     * Tries to mark the (conversationId, instructionId) pair as "seen" for this customer
     * using a conditional put (attribute_not_exists). Returns true if this is the first
     * time this pair has been seen (i.e. the write succeeded), false if it was already
     * recorded (ConditionalCheckFailedException).
     */
    suspend fun markInstructionUsageSeenIfNew(
        customerId: String,
        conversationId: String,
        instructionId: String
    ): Boolean = withContext(Dispatchers.IO) {
        val convInstKey = "${conversationId}#${instructionId}"
        try {
            val item = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY
                    to AttributeValue.builder().s(convInstKey).build(),
                DynamoDBConstants.INSTRUCTION_USAGE_SEEN_AT_KEY
                    to AttributeValue.builder().s(java.time.Instant.now().toString()).build()
            )
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE)
                    .item(item)
                    .conditionExpression("attribute_not_exists(${CUSTOMER_ID_KEY})")
                    .build()
            )
            true // first occurrence
        } catch (e: ConditionalCheckFailedException) {
            false // already counted
        }
    }

    /**
     * Atomically increments usageCount and updates lastUsedAt for the
     * (customerId, instructionId) pair in the InstructionUsage table.
     * Call this only after [markInstructionUsageSeenIfNew] returns true.
     */
    suspend fun incrementInstructionUsage(
        customerId: String,
        instructionId: String,
        lastUsedAt: String
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.INSTRUCTION_USAGE_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    INSTRUCTION_ID_KEY to AttributeValue.builder().s(instructionId).build()
                ))
                .updateExpression(
                    "SET ${DynamoDBConstants.INSTRUCTION_LAST_USED_KEY} = :ts " +
                    "ADD ${DynamoDBConstants.INSTRUCTION_USAGE_COUNT_KEY} :one"
                )
                .expressionAttributeValues(mapOf(
                    ":ts"  to AttributeValue.builder().s(lastUsedAt).build(),
                    ":one" to AttributeValue.builder().n("1").build()
                ))
                .build()
        )
        logger.info("Incremented usage count for instruction $instructionId / customer $customerId")
    }

    /**
     * The customer's own use of the instruction: how many conversations used it
     * and when it was last used in a new one. Null when they never used it.
     */
    suspend fun getInstructionUsage(customerId: String, instructionId: String): InstructionUsageCount? =
        withContext(Dispatchers.IO) {
            val item = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(DynamoDBConstants.INSTRUCTION_USAGE_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        INSTRUCTION_ID_KEY to AttributeValue.builder().s(instructionId).build()
                    ))
                    .build()
            ).item()
            if (item.isNullOrEmpty()) null else InstructionUsageCount(
                count = item[DynamoDBConstants.INSTRUCTION_USAGE_COUNT_KEY]?.n()?.toIntOrNull() ?: 0,
                lastUsedAt = item[DynamoDBConstants.INSTRUCTION_LAST_USED_KEY]?.s()
            )
        }

    /**
     * The customer's conversations that used the instruction, with when each
     * first did (null on rows from before that was kept). The sort key leads
     * with the conversation id, so this reads the customer's whole usage set
     * and keeps this instruction's rows.
     */
    suspend fun getInstructionConversations(customerId: String, instructionId: String): List<InstructionConversationUse> =
        withContext(Dispatchers.IO) {
            val suffix = "#$instructionId"
            dynamoDbClient.queryPaginator(
                QueryRequest.builder()
                    .tableName(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE)
                    .keyConditionExpression("#pk = :cid")
                    .expressionAttributeNames(mapOf("#pk" to CUSTOMER_ID_KEY))
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            ).items().mapNotNull { item ->
                val key = item[DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY]?.s() ?: return@mapNotNull null
                if (!key.endsWith(suffix)) return@mapNotNull null
                InstructionConversationUse(
                    conversationId = key.removeSuffix(suffix),
                    seenAt = item[DynamoDBConstants.INSTRUCTION_USAGE_SEEN_AT_KEY]?.s()
                )
            }
        }
}

data class InstructionUsageCount(val count: Int, val lastUsedAt: String?)

data class InstructionConversationUse(val conversationId: String, val seenAt: String?)
