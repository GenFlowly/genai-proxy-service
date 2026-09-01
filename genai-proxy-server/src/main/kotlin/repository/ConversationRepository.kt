package com.genflowly.repository

import com.genflowly.DynamoDBConstants.ARCHIVED_AT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_CUSTOMER_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.PINNED_AT_KEY
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the Conversation and Message tables.
 */
class ConversationRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun createConversation(
        conversation: Conversation
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(conversation.customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s
                    (conversation.conversationId)
                    .build(),
                "client" to AttributeValue.builder().s(conversation.client).build(),
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Created Conversation for ${conversation
                .customerId} to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to Create Conversation in DynamoDB", e)
            throw e
        }
    }

    suspend fun updateConversationTitle(
        conversationId: String,
        customerId: String,
        title: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .updateExpression("SET #t = :title")
                .expressionAttributeNames(mapOf("#t" to "title"))
                .expressionAttributeValues(mapOf(":title" to AttributeValue.builder().s(title).build()))
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Updated title for conversation $conversationId to '$title'")
        } catch (e: Exception) {
            logger.error("Failed to update conversation title in DynamoDB", e)
        }
    }

    suspend fun archiveConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #aa = :now")
                    .expressionAttributeNames(mapOf("#aa" to ARCHIVED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Archived conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to archive conversation $conversationId", e)
            throw e
        }
    }

    suspend fun unarchiveConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("REMOVE #aa")
                    .expressionAttributeNames(mapOf("#aa" to ARCHIVED_AT_KEY))
                    .build()
            )
            logger.info("Unarchived conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to unarchive conversation $conversationId", e)
            throw e
        }
    }

    suspend fun pinConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #pa = :now")
                    // Guard against creating a phantom row for a conversation that doesn't exist
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pa" to PINNED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Pinned conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to pin conversation $conversationId", e)
            throw e
        }
    }

    suspend fun unpinConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("REMOVE #pa")
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pa" to PINNED_AT_KEY))
                    .build()
            )
            logger.info("Unpinned conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to unpin conversation $conversationId", e)
            throw e
        }
    }

    suspend fun isConversationArchived(
        conversationId: String,
        customerId: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .projectionExpression(ARCHIVED_AT_KEY)
                .build()
            val response = dynamoDbClient.getItem(getReq)
            response.item()?.containsKey(ARCHIVED_AT_KEY) == true
        } catch (e: Exception) {
            logger.error("Failed to check archive status for conversation $conversationId", e)
            false
        }
    }

    suspend fun getConversationTitle(
        conversationId: String,
        customerId: String
    ): String? = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .build()
            val response = dynamoDbClient.getItem(getReq)
            response.item()?.get("title")?.s()
        } catch (e: Exception) {
            logger.error("Failed to get conversation title from DynamoDB", e)
            null
        }
    }

    /**
     * Looks up a Conversation row by conversationId alone via the [CONVERSATION_ID_GSI_KEY] GSI.
     * Needed for users who have a conversation shared with them and therefore don't
     * know the owner's customerId.
     */
    suspend fun getConversationById(conversationId: String): Conversation? = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_ID_GSI_KEY)
            .keyConditionExpression("$CONVERSATION_ID_KEY = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .limit(1)
            .build()

        val response = dynamoDbClient.query(request)
        val item = response.items().firstOrNull() ?: return@withContext null
        val ownerCustomerId = item[CUSTOMER_ID_KEY]?.s() ?: return@withContext null
        val client = item["client"]?.s() ?: return@withContext null
        Conversation(
            conversationId = conversationId,
            customerId = ownerCustomerId,
            client = client
        )
    }

    /**
     * Fetches up to [pageSize] conversations for the given customer, newest first,
     * using a GSI on the Conversation table keyed by customerId.
     *
     * @param customerId   Partition value to filter by.
     * @param pageSize     Maximum number of items to return (default 10).
     * @param exclusiveStartKey  Opaque JSON string returned as [GetCustomerConversationsResponse.lastEvaluatedKey]
     *                     from a previous call. Pass null for the first page.
     */
    suspend fun getConversationsByCustomerPaginated(
        customerId: String,
        pageSize: Int = 10,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse = withContext(Dispatchers.IO) {
        val queryBuilder = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_CUSTOMER_GSI_KEY)
            .keyConditionExpression("#cid = :cid")
            .filterExpression("attribute_not_exists(#aa)")
            .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#aa" to ARCHIVED_AT_KEY))
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(customerId).build()
            ))
            .scanIndexForward(false) // newest first (descending by sort key)
            .limit(pageSize)

        // Resume from prior page if a continuation token was supplied
        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                val startKey = keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() }
                queryBuilder.exclusiveStartKey(startKey)
            } catch (e: Exception) {
                logger.warn("Failed to parse exclusiveStartKey, starting from beginning: ${e.message}")
            }
        }

        val response = dynamoDbClient.query(queryBuilder.build())

        val conversations = response.items().mapNotNull { item ->
            val convId    = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
            val title     = item["title"]?.s()
            val createdAt = item["createdAt"]?.s()
            val updatedAt = item["updatedAt"]?.s()

            val messages = getMessagesForConversation(convId)
            val vendors = messages.flatMap { it.aiConfig }.map { it.aiVendor.name }.distinct().takeIf { it.isNotEmpty() }

            ConversationSummary(
                conversationId = convId,
                title = title,
                createdAt = createdAt,
                updatedAt = updatedAt,
                vendors = vendors
            )
        }

        // Serialise LastEvaluatedKey as a simple JSON string so it is safe to round-trip through the API
        val nextPageToken: String? = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
            val encoded = response.lastEvaluatedKey().mapValues { (_, v) -> v.s() ?: "" }
            Json.encodeToString(encoded)
        } else null

        GetCustomerConversationsResponse(conversations = conversations, lastEvaluatedKey = nextPageToken)
    }

    /**
     * Fetches all pinned (and not archived) conversations for the customer,
     * most recently pinned first.
     *
     * Queries the base table (not the customerId GSI) because the GSI projection
     * doesn't include [PINNED_AT_KEY] — the base table returns full items, so the
     * pinned filter can be evaluated without an index change.
     */
    suspend fun getPinnedConversationsByCustomer(
        customerId: String,
        maxItems: Int = 50
    ): List<ConversationSummary> = withContext(Dispatchers.IO) {
        val pinnedItems = mutableListOf<Map<String, AttributeValue>>()
        var startKey: Map<String, AttributeValue>? = null

        // A filtered query can return empty pages with a lastEvaluatedKey, so
        // keep paging until the key is absent (or we have enough items).
        do {
            val queryBuilder = QueryRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .keyConditionExpression("#cid = :cid")
                .filterExpression("attribute_exists(#pa) AND attribute_not_exists(#aa)")
                .expressionAttributeNames(mapOf(
                    "#cid" to CUSTOMER_ID_KEY,
                    "#pa" to PINNED_AT_KEY,
                    "#aa" to ARCHIVED_AT_KEY
                ))
                .expressionAttributeValues(mapOf(
                    ":cid" to AttributeValue.builder().s(customerId).build()
                ))
            startKey?.let { queryBuilder.exclusiveStartKey(it) }

            val response = dynamoDbClient.query(queryBuilder.build())
            pinnedItems += response.items()
            startKey = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
                response.lastEvaluatedKey()
            } else null
        } while (startKey != null && pinnedItems.size < maxItems)

        pinnedItems
            .sortedByDescending { it[PINNED_AT_KEY]?.s() ?: "" }
            .take(maxItems)
            .mapNotNull { item ->
                val convId = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null

                val messages = getMessagesForConversation(convId)
                val vendors = messages.flatMap { it.aiConfig }.map { it.aiVendor.name }.distinct().takeIf { it.isNotEmpty() }

                ConversationSummary(
                    conversationId = convId,
                    title = item["title"]?.s(),
                    createdAt = item["createdAt"]?.s(),
                    updatedAt = item["updatedAt"]?.s(),
                    pinnedAt = item[PINNED_AT_KEY]?.s(),
                    vendors = vendors
                )
            }
    }

    // ─── Messages ─────────────────────────────────────────────────────────────

    suspend fun getMessage(
        conversationId: String,
        messageId: String
    ): Message? = withContext(Dispatchers.IO) {

        val key = mapOf(
            "conversationId" to AttributeValue.builder().s(conversationId).build(),
            "messageId" to AttributeValue.builder().s(messageId).build()
        )

        val request = GetItemRequest.builder()
            .tableName(MESSAGE_TABLE)
            .key(key)
            .build()

        val response = dynamoDbClient.getItem(request)
        val item = response.item() ?: return@withContext null
        return@withContext itemToMessage(item)
    }

    suspend fun getMessagesForConversation(
        conversationId: String
    ): List<Message> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(MESSAGE_TABLE)
            .keyConditionExpression("conversationId = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { itemToMessage(it) }
    }

    suspend fun createMessage(
        message: Message
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(
                mutableMapOf(
                    CONVERSATION_ID_KEY to AttributeValue.builder()
                        .s(message.conversationId)
                        .build(),

                    MESSAGE_ID_SORT_KEY to AttributeValue.builder()
                        .s(message.messageId)
                        .build(),

                    CUSTOMER_ID_KEY to AttributeValue.builder()
                        .s(message.customerId)
                        .build(),

                    "sequence" to AttributeValue.builder()
                        .n(message.sequence?.toString() ?: "0")
                        .build(),

                    "client" to AttributeValue.builder()
                        .s(message.client)
                        .build(),

                    "aiConfig" to aiConfigToAttributeValue(message.aiConfig),

                    "role" to AttributeValue.builder()
                        .s(message.role)
                        .build(),

                    "text" to AttributeValue.builder()
                        .s(message.text)
                        .build(),

                    "systemPrompt" to AttributeValue.builder()
                        .s(message.systemPrompt)
                        .build(),

                    "previousMessageId" to AttributeValue.builder()
                        .s(message.previousMessageId ?: "")
                        .build(),

                    "instructionId" to AttributeValue.builder()
                        .s(message.instructionId ?: "")
                        .build(),

                    "instructionVersion" to AttributeValue.builder()
                        .s(message.instructionVersion ?: "")
                        .build()
                ).also { map ->
                    if (message.attachments.isNotEmpty()) {
                        map["attachments"] = attachmentsToAttributeValue(message.attachments)
                    }
                    message.toolCallsJson?.let {
                        map["toolCallsJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.toolResultsJson?.let {
                        map["toolResultsJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.webSourcesJson?.let {
                        map["webSourcesJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.inputTokens?.let {
                        map["inputTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.outputTokens?.let {
                        map["outputTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.totalTokens?.let {
                        map["totalTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.tokensReadFromCache?.let {
                        map["tokensReadFromCache"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.thinkingDurationMs?.let {
                        map["thinkingDurationMs"] = AttributeValue.builder().n(it.toString()).build()
                    }
                }
            )

            val putReq = PutItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)

            logger.info(
                "Saved message for conversation {} to DynamoDB",
                message.conversationId
            )
        } catch (e: Exception) {
            logger.error("Failed to create Message in DynamoDB", e)
            throw e
        }
    }

    private fun itemToMessage(item: Map<String, AttributeValue>): Message? {
        val text = item["text"]?.s() ?: return null
        val sequenceStr = item["sequence"]?.n() ?: return null
        val client = item["client"]?.s() ?: return null
        val role = item["role"]?.s() ?: return null
        val customerId = item["customerId"]?.s() ?: return null
        val systemPrompt = item["systemPrompt"]?.s() ?: return null

        val previousMessageId = item["previousMessageId"]?.s()
        val instructionId = item["instructionId"]?.s()?.takeIf { it.isNotBlank() }
        val instructionVersion = item["instructionVersion"]?.s()?.takeIf { it.isNotBlank() }

        val sequence = sequenceStr.toIntOrNull() ?: return null

        val aiConfigAttr = item["aiConfig"] ?: return null
        val aiConfig = attributeValueToAiConfig(aiConfigAttr)

        val inputTokens = item["inputTokens"]?.n()?.toIntOrNull()
        val outputTokens = item["outputTokens"]?.n()?.toIntOrNull()
        val totalTokens = item["totalTokens"]?.n()?.toIntOrNull()
        val tokensReadFromCache = item["tokensReadFromCache"]?.n()?.toIntOrNull()

        return Message(
            messageId = item["messageId"]?.s() ?: return null,
            conversationId = item["conversationId"]?.s() ?: return null,
            text = text,
            attachments = attributeValueToAttachments(item["attachments"]),
            toolCallsJson = item["toolCallsJson"]?.s()?.takeIf { it.isNotBlank() },
            toolResultsJson = item["toolResultsJson"]?.s()?.takeIf { it.isNotBlank() },
            webSourcesJson = item["webSourcesJson"]?.s()?.takeIf { it.isNotBlank() },
            client = client,
            role = role,
            customerId = customerId,
            sequence = sequence,
            systemPrompt = systemPrompt,
            aiConfig = aiConfig,
            previousMessageId = previousMessageId,
            instructionId = instructionId,
            instructionVersion = instructionVersion,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            totalTokens = totalTokens,
            tokensReadFromCache = tokensReadFromCache,
            thinkingDurationMs = item["thinkingDurationMs"]?.n()?.toLongOrNull(),
            createdAt = item["createdAt"]?.s()
        )
    }

    private fun attachmentsToAttributeValue(
        attachments: List<com.genflowly.models.AttachmentRef>
    ): AttributeValue =
        AttributeValue.builder()
            .l(
                attachments.map { attachment ->
                    AttributeValue.builder()
                        .m(
                            mapOf(
                                "attachmentId" to AttributeValue.builder().s(attachment.attachmentId).build(),
                                "s3Key" to AttributeValue.builder().s(attachment.s3Key).build(),
                                "mediaType" to AttributeValue.builder().s(attachment.mediaType).build()
                            )
                        )
                        .build()
                }
            )
            .build()

    private fun attributeValueToAttachments(
        attributeValue: AttributeValue?
    ): List<com.genflowly.models.AttachmentRef> =
        attributeValue?.l()?.mapNotNull { av ->
            val map = av.m()
            val attachmentId = map["attachmentId"]?.s() ?: return@mapNotNull null
            val s3Key = map["s3Key"]?.s() ?: return@mapNotNull null
            val mediaType = map["mediaType"]?.s() ?: return@mapNotNull null
            com.genflowly.models.AttachmentRef(attachmentId = attachmentId, s3Key = s3Key, mediaType = mediaType)
        } ?: emptyList()
}
