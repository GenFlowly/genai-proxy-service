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
     * Message count of the conversation at the time of the last extraction run,
     * or null when the conversation has never been processed.
     */
    suspend fun getConversationExtractionMark(
        customerId: String,
        conversationId: String
    ): Int? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .key(memoryKey(customerId, "$MEMORY_CONV_META_PREFIX$conversationId"))
                .build()
        )
        response.item()?.get("processedMessageCount")?.n()?.toIntOrNull()
    }

    suspend fun setConversationExtractionMark(
        customerId: String,
        conversationId: String,
        processedMessageCount: Int
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.putItem(
            PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                .item(
                    mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        MEMORY_ID_KEY to AttributeValue.builder()
                            .s("$MEMORY_CONV_META_PREFIX$conversationId").build(),
                        "processedMessageCount" to AttributeValue.builder()
                            .n(processedMessageCount.toString()).build(),
                        "updatedAt" to AttributeValue.builder().s(Instant.now().toString()).build()
                    )
                )
                .build()
        )
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
