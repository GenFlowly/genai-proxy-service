package com.genflowly.providers

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.NODE_CONFIG_KEY
import com.genflowly.DynamoDBConstants.NODE_ID_KEY
import com.genflowly.DynamoDBConstants.NODE_NAME_KEY
import com.genflowly.DynamoDBConstants.NODE_TYPE_KEY
import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CLIENT_SORT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CONVERSATION_CUSTOMER_GSI_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPHS_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE
import com.genflowly.DynamoDBConstants.GRAPH_NODE_IDS_KEY
import com.genflowly.DynamoDBConstants.GRAPH_EDGES_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ENTRY_POINT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ID_KEY
import com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_MAX_ITERATIONS_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NAME_KEY
import com.genflowly.DynamoDBConstants.VENDOR_KEY
import com.genflowly.DynamoDBConstants.VERSION_KEY
import com.genflowly.DynamoDBConstants.LATEST_VERSION_KEY
import com.genflowly.DynamoDBConstants.DELETED_AT_KEY
import com.genflowly.DynamoDBConstants.ARCHIVED_AT_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPHS_GSI_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CONTENT_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_GSI_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_CREATOR_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_ID_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_NAME_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_TABLE
import com.genflowly.DynamoDBConstants.INSTRUCTION_VERSION_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.SUB_PARTITION_KEY
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import models.AIConfig
import models.Conversation
import models.Message
import models.ModelCatalogEntry
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutRequest
import software.amazon.awssdk.services.dynamodb.model.WriteRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.KeysAndAttributes
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString

class DynamoDBProvider(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {
    // Instruction content cache. A given (id, version) is IMMUTABLE — editing an
    // instruction creates a new version — so cached content never goes stale and
    // needs no invalidation. Positive-only (misses are not cached). Soft-capped.
    private val instructionCache = ConcurrentHashMap<String, models.Instruction>()
    private val INSTRUCTION_CACHE_MAX = 10_000

    suspend fun getConversation(conversationId: String, customerId: String): Conversation? =
        withContext(Dispatchers.IO) {
            try {
                val key = mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                )

                val request = GetItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(key)
                    .build()

                val response = dynamoDbClient.getItem(request)
                val item = response.item() ?: return@withContext null
                if (item.isEmpty()) return@withContext null

                val client = item["client"]?.s() ?: return@withContext null

                Conversation(
                    conversationId = conversationId,
                    customerId = customerId,
                    client = client
                )
            } catch (e: Exception) {
                logger.error("Failed to Get Conversation from DynamoDB", e)
                throw e
            }
        }




    suspend fun getCustomerApiKey(aiVendor: String, customerId: String): String? =
        withContext(Dispatchers.IO) {
        val key = mapOf(
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId)
                .build(),
            AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
        )

        val request =
            GetItemRequest.builder().tableName(CUSTOMER_API_KEY_TABLE).key(key)
                .build()

        val response = dynamoDbClient.getItem(request)
            return@withContext response.item()?.get("apiKey")?.s()
    }


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
        val request = software.amazon.awssdk.services.dynamodb.model.QueryRequest.builder()
            .tableName(MESSAGE_TABLE)
            .keyConditionExpression("conversationId = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { itemToMessage(it) }
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

    private fun attributeValueToAiConfig(
        attributeValue: AttributeValue
    ): List<AIConfig> =
        attributeValue.l().map { av ->
            val map = av.m()
            AIConfig(
                aiVendor = AIVendor.valueOf(map["aiVendor"]!!.s()),
                model = map["model"]!!.s()
            )
        }

    private fun attachmentsToAttributeValue(
        attachments: List<models.AttachmentRef>
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
    ): List<models.AttachmentRef> =
        attributeValue?.l()?.mapNotNull { av ->
            val map = av.m()
            val attachmentId = map["attachmentId"]?.s() ?: return@mapNotNull null
            val s3Key = map["s3Key"]?.s() ?: return@mapNotNull null
            val mediaType = map["mediaType"]?.s() ?: return@mapNotNull null
            models.AttachmentRef(attachmentId = attachmentId, s3Key = s3Key, mediaType = mediaType)
        } ?: emptyList()


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

    private fun aiConfigToAttributeValue(
        aiConfig: List<AIConfig>
    ): AttributeValue =
        AttributeValue.builder()
            .l(
                aiConfig.map { config ->
                    AttributeValue.builder()
                        .m(
                            mapOf(
                                "aiVendor" to AttributeValue.builder()
                                    .s(config.aiVendor.name)
                                    .build(),
                                "model" to AttributeValue.builder()
                                    .s(config.model)
                                    .build()
                            )
                        )
                        .build()
                }
            )
            .build()

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?,
        embeddingMode: String? = null,
        embeddingModel: String? = null,
        preferredInstructionId: String? = null,
        instructionFallbackMode: String? = null
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val updateParts = mutableListOf<String>()
            val attrNames = mutableMapOf<String, String>()
            val attrValues = mutableMapOf<String, AttributeValue>()

            // Always update updatedAt
            updateParts.add("#updatedAt = :updatedAt")
            attrNames["#updatedAt"] = "updatedAt"
            attrValues[":updatedAt"] = AttributeValue.builder().s(now).build()

            // set createdAt if not exists
            updateParts.add("#createdAt = if_not_exists(#createdAt, :createdAt)")
            attrNames["#createdAt"] = "createdAt"
            attrValues[":createdAt"] = AttributeValue.builder().s(now).build()

            if (preferredGenerativeMode != null) {
                updateParts.add("#preferredGenerativeMode = :preferredGenerativeMode")
                attrNames["#preferredGenerativeMode"] = "preferredGenerativeMode"
                attrValues[":preferredGenerativeMode"] = AttributeValue.builder().s(preferredGenerativeMode.name).build()
            }

            if (preferredModels != null) {
                updateParts.add("#preferredModels = :preferredModels")
                attrNames["#preferredModels"] = "preferredModels"
                attrValues[":preferredModels"] = aiConfigToAttributeValue(preferredModels)
            }

            if (!otherPreferences.isNullOrEmpty()) {
                updateParts.add("#otherPreferences = :otherPreferences")
                attrNames["#otherPreferences"] = "otherPreferences"
                attrValues[":otherPreferences"] = AttributeValue.builder().m(
                    otherPreferences.mapValues { AttributeValue.builder().s(it.value).build() }
                ).build()
            }

            if (embeddingMode != null) {
                updateParts.add("#embeddingMode = :embeddingMode")
                attrNames["#embeddingMode"] = "embeddingMode"
                attrValues[":embeddingMode"] = AttributeValue.builder().s(embeddingMode).build()
            }

            if (embeddingModel != null) {
                updateParts.add("#embeddingModel = :embeddingModel")
                attrNames["#embeddingModel"] = "embeddingModel"
                attrValues[":embeddingModel"] = AttributeValue.builder().s(embeddingModel).build()
            }

            if (preferredInstructionId != null) {
                updateParts.add("#preferredInstructionId = :preferredInstructionId")
                attrNames["#preferredInstructionId"] = "preferredInstructionId"
                attrValues[":preferredInstructionId"] = AttributeValue.builder().s(preferredInstructionId).build()
            }

            if (instructionFallbackMode != null) {
                updateParts.add("#instructionFallbackMode = :instructionFallbackMode")
                attrNames["#instructionFallbackMode"] = "instructionFallbackMode"
                attrValues[":instructionFallbackMode"] = AttributeValue.builder().s(instructionFallbackMode).build()
            }

            val updateReq = UpdateItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()))
                .updateExpression("SET " + updateParts.joinToString(", "))
                .expressionAttributeNames(attrNames)
                .expressionAttributeValues(attrValues)
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Saved preferences for customer $customerId to DynamoDB (Upsert)")
        } catch (e: Exception) {
            logger.error("Failed to save Customer Preferences to DynamoDB", e)
            throw e
        }
    }

    suspend fun saveCustomerApiKey(
        customerId: String,
        aiVendor: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor)
                    .build(),
                "apiKey" to AttributeValue.builder().s(encryptedKey).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved API key for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun saveDeveloperApiKey(
        keyHash: String,
        keyId: String,
        customerId: String,
        name: String,
        prefix: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build(),
                "keyId" to AttributeValue.builder().s(keyId).build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                "name" to AttributeValue.builder().s(name).build(),
                "prefix" to AttributeValue.builder().s(prefix).build(),
                "encryptedKey" to AttributeValue.builder().s(encryptedKey).build(),
                "revoked" to AttributeValue.builder().bool(false).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved developer API key $keyId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to save developer API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun getDeveloperApiKeyByHash(keyHash: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
            )
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                    .key(key)
                    .build()
            )
            if (response.hasItem()) response.item() else null
        }

    suspend fun queryDeveloperApiKeysByCustomer(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            val queryReq = QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .indexName(DynamoDBConstants.DEVELOPER_API_KEY_CUSTOMER_GSI)
                .keyConditionExpression("customerId = :cid")
                .expressionAttributeValues(
                    mapOf(":cid" to AttributeValue.builder().s(customerId).build())
                )
                .build()
            dynamoDbClient.query(queryReq).items()
        }

    suspend fun deleteDeveloperApiKey(keyHash: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .key(mapOf(
                    DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
                ))
                .build()
        )
    }

    suspend fun updateDeveloperApiKeyLastUsed(keyHash: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                    .key(mapOf(
                        DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
                    ))
                    .updateExpression("SET lastUsedAt = :now")
                    .expressionAttributeValues(
                        mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build())
                    )
                    .build()
            )
        } catch (e: Exception) {
            // Best-effort only; never fail a request because the usage timestamp couldn't be written
            logger.warn("Failed to update lastUsedAt for developer API key", e)
        }
    }

    suspend fun saveCustomerVectorDBConfig(
        customerId: String,
        vendor: String,
        encryptedEndpoint: String,
        encryptedToken: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                VENDOR_KEY to AttributeValue.builder().s(vendor).build(),
                "endpoint" to AttributeValue.builder().s(encryptedEndpoint).build(),
                "token" to AttributeValue.builder().s(encryptedToken).build(),
                "isConfigValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_VECTOR_DB_CONFIG_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved Vector DB Config for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save Vector DB config to DynamoDB", e)
            throw e
        }
    }

    suspend fun saveCustomerSupabaseConfig(
        customerId: String,
        encryptedEndpoint: String,
        encryptedToken: String,
        encryptedPassword: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                "endpoint" to AttributeValue.builder().s(encryptedEndpoint).build(),
                "token" to AttributeValue.builder().s(encryptedToken).build(),
                "password" to AttributeValue.builder().s(encryptedPassword).build(),
                "isConfigValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_SUPABASE_CONFIG_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved Supabase Config for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save Supabase config to DynamoDB", e)
            throw e
        }
    }

    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<models.VectorDBConfigStatus> = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CUSTOMER_VECTOR_DB_CONFIG_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
                ))
                .build()

            val response = dynamoDbClient.getItem(getReq)
            
            if (response.hasItem()) {
                val item = response.item()
                val status = if (item["isConfigValid"]?.bool() == true) {
                    models.VectorDBConfigStatusValue.PRESENT
                } else {
                    models.VectorDBConfigStatusValue.NOT_SET
                }

                listOf(
                    models.VectorDBConfigStatus(
                        vendor = item[VENDOR_KEY]?.s() ?: "Zilliz",
                        isConfigValid = item["isConfigValid"]?.bool() ?: false,
                        status = status,
                        updateSuccessful = true
                    )
                )
            } else {
                emptyList()
            }
        } catch (e: Exception) {
            logger.error("Failed to get Vector DB config status list from DynamoDB", e)
            emptyList()
        }
    }

    suspend fun saveNote(
        customerId: String,
        noteKey: String,
        noteValue: String,
        title: String,
        createdAt: String
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val names = mutableMapOf(
                "#noteValue" to "noteValue",
                "#title" to "title",
                "#noteCreatedAt" to "noteCreatedAt",
                "#createdAt" to "createdAt",
                "#updatedAt" to "updatedAt",
                "#synced" to "is_synced_with_milvus",
                "#milvusIds" to "milvus_ids",
                "#isDelete" to "is_delete"
            )
            val values = mutableMapOf(
                ":noteValue" to AttributeValue.builder().s(noteValue).build(),
                ":noteCreatedAt" to AttributeValue.builder().s(createdAt).build(),
                ":now" to AttributeValue.builder().s(now).build(),
                ":synced" to AttributeValue.builder().bool(false).build(),
                ":milvusIds" to AttributeValue.builder().l(emptyList()).build(),
                ":notDeleted" to AttributeValue.builder().bool(false).build()
            )
            val setParts = mutableListOf(
                "#noteValue = :noteValue",
                "#noteCreatedAt = :noteCreatedAt",
                "#createdAt = if_not_exists(#createdAt, :now)",
                "#updatedAt = :now",
                "#synced = :synced",
                "#milvusIds = :milvusIds",
                // Saving always leaves the note visible (a re-save of a
                // soft-deleted key resurrects it)
                "#isDelete = :notDeleted"
            )
            if (title.isNotBlank() && title != "Untitled") {
                setParts.add("#title = :title")
                values[":title"] = AttributeValue.builder().s(title).build()
            } else {
                // Autosaves carry no real title; keep an existing (possibly
                // generated) one instead of resetting it to the default
                setParts.add("#title = if_not_exists(#title, :defaultTitle)")
                values[":defaultTitle"] = AttributeValue.builder().s("Untitled").build()
            }

            val updateReq = UpdateItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    com.genflowly.DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression("SET ${setParts.joinToString(", ")}")
                .expressionAttributeNames(names)
                .expressionAttributeValues(values)
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Saved Note $noteKey for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save note to DynamoDB", e)
            throw e
        }
    }

    /**
     * Flags a note for batch embedding: sets embedding_status=pending plus the
     * model to use. The encoding server's accumulator sweeps these off the
     * sparse embedding-status-index GSI. Replaces the synchronous /encode-notes
     * call for batch-mode customers.
     */
    suspend fun markNotePendingEmbedding(
        customerId: String,
        noteKey: String,
        embeddingModelType: String,
        embeddingModel: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    com.genflowly.DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression(
                    "SET #status = :status, #modelType = :modelType, #model = :model, #updatedAt = :now"
                )
                .conditionExpression("attribute_exists(${com.genflowly.DynamoDBConstants.NOTE_KEY})")
                .expressionAttributeNames(mapOf(
                    "#status" to "embedding_status",
                    "#modelType" to "embedding_model_type",
                    "#model" to "embedding_model",
                    "#updatedAt" to "embedding_updated_at"
                ))
                .expressionAttributeValues(mapOf(
                    ":status" to AttributeValue.builder().s("pending").build(),
                    ":modelType" to AttributeValue.builder().s(embeddingModelType).build(),
                    ":model" to AttributeValue.builder().s(embeddingModel).build(),
                    ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                ))
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Marked note $noteKey of $customerId pending batch embedding ($embeddingModel)")
        } catch (e: Exception) {
            logger.error("Failed to mark note $noteKey pending embedding", e)
            throw e
        }
    }

    suspend fun updateNoteTitle(
        customerId: String,
        noteKey: String,
        title: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    com.genflowly.DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression("SET #title = :title, #updatedAt = :now")
                .conditionExpression("attribute_exists(${com.genflowly.DynamoDBConstants.NOTE_KEY})")
                .expressionAttributeNames(mapOf("#title" to "title", "#updatedAt" to "updatedAt"))
                .expressionAttributeValues(mapOf(
                    ":title" to AttributeValue.builder().s(title).build(),
                    ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                ))
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Updated title for note $noteKey of $customerId")
        } catch (e: ConditionalCheckFailedException) {
            // Note was deleted between the save and the title generation
            logger.warn("Skipped title update for missing note $noteKey of $customerId")
        } catch (e: Exception) {
            logger.error("Failed to update note title in DynamoDB", e)
            throw e
        }
    }

    /**
     * Soft-delete a note: the DDB item is kept but flagged is_delete=true so
     * it disappears from listings. Returns false when the note doesn't exist.
     */
    suspend fun softDeleteNote(
        customerId: String,
        noteKey: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        com.genflowly.DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                    ))
                    .updateExpression("SET #isDelete = :true, #deletedAt = :now, #updatedAt = :now")
                    .conditionExpression("attribute_exists(${com.genflowly.DynamoDBConstants.NOTE_KEY})")
                    .expressionAttributeNames(mapOf(
                        "#isDelete" to "is_delete",
                        "#deletedAt" to "deletedAt",
                        "#updatedAt" to "updatedAt"
                    ))
                    .expressionAttributeValues(mapOf(
                        ":true" to AttributeValue.builder().bool(true).build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                    ))
                    .build()
            )
            logger.info("Soft-deleted note $noteKey for customer $customerId")
            true
        } catch (e: ConditionalCheckFailedException) {
            logger.warn("Skipped soft delete for missing note $noteKey of $customerId")
            false
        } catch (e: Exception) {
            logger.error("Failed to soft-delete note $noteKey for $customerId", e)
            throw e
        }
    }

    suspend fun getNotes(customerId: String): List<Map<String, AttributeValue>> = withContext(Dispatchers.IO) {
        try {
            val items = mutableListOf<Map<String, AttributeValue>>()
            var exclusiveStartKey: Map<String, AttributeValue>? = null

            do {
                val queryBuilder = QueryRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                    .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
                    // Soft-deleted notes stay in the table but never in listings
                    .filterExpression("attribute_not_exists(#isDelete) OR #isDelete = :notDeleted")
                    .expressionAttributeNames(mapOf("#isDelete" to "is_delete"))
                    .expressionAttributeValues(
                        mapOf(
                            ":cid" to AttributeValue.builder().s(customerId).build(),
                            ":notDeleted" to AttributeValue.builder().bool(false).build()
                        )
                    )

                if (!exclusiveStartKey.isNullOrEmpty()) {
                    queryBuilder.exclusiveStartKey(exclusiveStartKey)
                }

                val response = dynamoDbClient.query(queryBuilder.build())
                items.addAll(response.items())
                exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
            } while (!exclusiveStartKey.isNullOrEmpty())

            logger.info("Fetched ${items.size} notes for $customerId from DynamoDB")
            items
        } catch (e: Exception) {
            logger.error("Failed to get notes from DynamoDB", e)
            throw e
        }
    }

    suspend fun getCustomerSupabaseConfigStatus(customerId: String): models.SupabaseConfigStatus? = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_SUPABASE_CONFIG_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
                ))
                .build()

            val response = dynamoDbClient.getItem(getReq)
            
            if (response.hasItem()) {
                val item = response.item()
                val status = if (item["isConfigValid"]?.bool() == true) {
                    models.SupabaseConfigStatusValue.PRESENT
                } else {
                    models.SupabaseConfigStatusValue.NOT_SET
                }

                models.SupabaseConfigStatus(
                    isConfigValid = item["isConfigValid"]?.bool() ?: false,
                    status = status,
                    updateSuccessful = true
                )
            } else {
                null
            }
        } catch (e: Exception) {
            logger.error("Failed to get Supabase config status from DynamoDB", e)
            null
        }
    }

    suspend fun initCustomerApiKey(
        customerId: String,
        aiVendor: String
    ) = withContext(Dispatchers.IO) {
        try {
            // Initial state: Valid = false, no apiKey
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(false).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Initialized API key status for $customerId vendor $aiVendor")
        } catch (e: Exception) {
            logger.error("Failed to init API key status", e)
            // Non-blocking error for onboarding? Or should we throw?
            // Logging is safer for now.
        }
    }

    private suspend fun generateAndReserveUsername(sub: String, client: String, customerId: String, name: String?): String {
        var attempt = 0
        val baseUsername = name?.lowercase()?.replace(Regex("[^a-z0-9]"), "")?.takeIf { it.isNotBlank() } ?: "user"
        
        while(attempt < 3) {
            val hash = java.util.UUID.randomUUID().toString().substring(0, 6)
            val generatedUsername = "$baseUsername-$hash"
            
            try {
                val putUsernameReq = PutItemRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.USERNAME_LOOKUP_TABLE)
                    .item(mapOf(
                        "username" to AttributeValue.builder().s(generatedUsername).build(),
                        "recordType" to AttributeValue.builder().s("USER").build(),
                        "customerId" to AttributeValue.builder().s(customerId).build()
                    ))
                    .conditionExpression("attribute_not_exists(username)")
                    .build()
                dynamoDbClient.putItem(putUsernameReq)
                return generatedUsername
            } catch (e: software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException) {
                attempt++
            }
        }
        throw IllegalStateException("Failed to generate unique username after 3 attempts")
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?,
        picture: String?
    ): String = withContext(Dispatchers.IO) {
        val generatedUsername = generateAndReserveUsername(sub, client, customerId, name)

        val baseItem = buildMap {
            put(SUB_PARTITION_KEY, AttributeValue.builder().s(sub).build())
            put(CLIENT_SORT_KEY, AttributeValue.builder().s(client).build())
            put("customerId", AttributeValue.builder().s(customerId).build())

            email?.let { put("email", AttributeValue.builder().s(it).build()) }
            name?.let { put("name", AttributeValue.builder().s(it).build()) }
            picture?.let { put("picture", AttributeValue.builder().s(it).build()) }
            
            put("username", AttributeValue.builder().s(generatedUsername).build())
            put("isDiscoverable", AttributeValue.builder().bool(false).build())
        }

        val item = withTimestamps(baseItem)

        val putReq = PutItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .item(item)
            .build()

        dynamoDbClient.putItem(putReq)
        logger.info { "Onboarded user $sub in DynamoDB with customerId: $customerId" }
        generatedUsername
    }

    suspend fun getCustomerProfileByCustomerId(customerId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val queryReq = QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .indexName(com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_CUSTOMER_ID_GSI)
                .keyConditionExpression("customerId = :cid")
                .expressionAttributeValues(
                    mapOf(":cid" to AttributeValue.builder().s(customerId).build())
                )
                .limit(1)
                .build()
                
            val response = dynamoDbClient.query(queryReq)
            val item = response.items().firstOrNull() ?: return@withContext null
            
            // Re-use logic to ensure username is populated? 
            // In getCustomerProfile we check if username exists. Let's just return the item here.
            // If they need username generation, it should happen at onboarding.
            if (!item.containsKey("username") || item["username"]?.s().isNullOrBlank()) {
                // If it doesn't have a username, we shouldn't really be doing generateAndReserveUsername here since we don't have sub/client easily without parsing them from the item.
                // But the item HAS sub and client. We can defer to getCustomerProfile to handle it.
                val sub = item["sub"]?.s()
                val client = item["client"]?.s()
                if (sub != null && client != null) {
                    return@withContext getCustomerProfile(sub, client)
                }
            }
            item
        }

    suspend fun getCustomerProfile(sub: String, client: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .key(
                    mapOf(
                        SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                        CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
                    )
                )
                .build()

            val response = dynamoDbClient.getItem(request)
            var item = response.item().takeIf { it.isNotEmpty() } ?: return@withContext null

            if (!item.containsKey("username") || item["username"]?.s().isNullOrBlank()) {
                val customerId = item["customerId"]?.s() ?: return@withContext item
                val name = item["name"]?.s()
                
                try {
                    val generatedUsername = generateAndReserveUsername(sub, client, customerId, name)
                    val updateReq = UpdateItemRequest.builder()
                        .tableName(CUSTOMER_PROFILE_TABLE)
                        .key(mapOf(
                            SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                            CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
                        ))
                        .updateExpression("SET username = :u, isDiscoverable = if_not_exists(isDiscoverable, :d)")
                        .expressionAttributeValues(mapOf(
                            ":u" to AttributeValue.builder().s(generatedUsername).build(),
                            ":d" to AttributeValue.builder().bool(false).build()
                        ))
                        .build()
                    dynamoDbClient.updateItem(updateReq)
                    
                    val updatedItem = item.toMutableMap()
                    updatedItem["username"] = AttributeValue.builder().s(generatedUsername).build()
                    if (!updatedItem.containsKey("isDiscoverable")) {
                        updatedItem["isDiscoverable"] = AttributeValue.builder().bool(false).build()
                    }
                    item = updatedItem
                } catch (e: Exception) {
                    logger.error("Failed to lazy generate username for $sub", e)
                }
            }

            return@withContext item
        }

    suspend fun updateUsername(
        sub: String,
        client: String,
        customerId: String,
        oldUsername: String?,
        newUsername: String
    ) = withContext(Dispatchers.IO) {
        // Reserve new username
        val putUsernameReq = PutItemRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.USERNAME_LOOKUP_TABLE)
            .item(mapOf(
                "username" to AttributeValue.builder().s(newUsername).build(),
                "recordType" to AttributeValue.builder().s("USER").build(),
                "customerId" to AttributeValue.builder().s(customerId).build()
            ))
            .conditionExpression("attribute_not_exists(username)")
            .build()
        
        try {
            dynamoDbClient.putItem(putUsernameReq)
        } catch (e: software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException) {
            throw IllegalArgumentException("Username is already taken")
        }
        
        // Update profile
        val updateReq = UpdateItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .key(mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            ))
            .updateExpression("SET username = :u")
            .expressionAttributeValues(mapOf(":u" to AttributeValue.builder().s(newUsername).build()))
            .build()
        dynamoDbClient.updateItem(updateReq)
        
        // Cleanup old
        if (!oldUsername.isNullOrBlank()) {
            val delReq = DeleteItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.USERNAME_LOOKUP_TABLE)
                .key(mapOf("username" to AttributeValue.builder().s(oldUsername).build()))
                .build()
            dynamoDbClient.deleteItem(delReq)
        }
    }

    suspend fun updateDiscoverability(
        sub: String,
        client: String,
        isDiscoverable: Boolean
    ) = withContext(Dispatchers.IO) {
        val updateReq = UpdateItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .key(mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            ))
            .updateExpression("SET isDiscoverable = :d")
            .expressionAttributeValues(mapOf(":d" to AttributeValue.builder().bool(isDiscoverable).build()))
            .build()
        dynamoDbClient.updateItem(updateReq)
    }

    suspend fun searchByUsername(usernamePrefix: String): List<com.genflowly.models.api.SearchCustomerResponse> = withContext(Dispatchers.IO) {
        val queryReq = QueryRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.USERNAME_LOOKUP_TABLE)
            .indexName(com.genflowly.DynamoDBConstants.USERNAME_RECORD_TYPE_GSI)
            .keyConditionExpression("recordType = :type AND begins_with(username, :prefix)")
            .expressionAttributeValues(mapOf(
                ":type" to AttributeValue.builder().s("USER").build(),
                ":prefix" to AttributeValue.builder().s(usernamePrefix).build()
            ))
            .limit(5)
            .build()
        
        val response = dynamoDbClient.query(queryReq)
        val results = mutableListOf<com.genflowly.models.api.SearchCustomerResponse>()
        
        for (item in response.items()) {
            val customerId = item["customerId"]?.s() ?: continue
            val username = item["username"]?.s() ?: continue
            
            val profileItem = getCustomerProfileByCustomerId(customerId) ?: continue
            val isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false
            if (!isDiscoverable) continue
            
            results.add(
                com.genflowly.models.api.SearchCustomerResponse(
                    customerId = profileItem["customerId"]?.s() ?: "",
                    name = profileItem["name"]?.s(),
                    username = username,
                    picture = profileItem["picture"]?.s()
                )
            )
        }
        
        results
    }

    /**
     * Query customer profile by sub only (partition key)
     * Returns the first matching profile if multiple clients exist for the same sub
     */
    suspend fun queryCustomerProfileBySub(sub: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .keyConditionExpression("#sub = :sub")
                .expressionAttributeNames(
                    mapOf("#sub" to SUB_PARTITION_KEY)
                )
                .expressionAttributeValues(
                    mapOf(":sub" to AttributeValue.builder().s(sub).build())
                )
                .limit(1)  // Only need the first result
                .build()

            val response = dynamoDbClient.query(request)
            return@withContext response.items().firstOrNull()
        }


    suspend fun saveSystemApiKey(
        aiVendor: String,
        encryptedKey: String,
        updatedBy: String
    ) = withContext(Dispatchers.IO) {
        try {
            // Upsert instead of PutItem so rotating a key preserves the
            // vendor's saved model/priority configuration
            val now = Instant.now().toString()
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                    .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                    .updateExpression(
                        "SET apiKey = :key, isAPIKeyValid = :valid, updatedBy = :by, " +
                                "updatedAt = :now, createdAt = if_not_exists(createdAt, :now)"
                    )
                    .expressionAttributeValues(mapOf(
                        ":key" to AttributeValue.builder().s(encryptedKey).build(),
                        ":valid" to AttributeValue.builder().bool(true).build(),
                        ":by" to AttributeValue.builder().s(updatedBy).build(),
                        ":now" to AttributeValue.builder().s(now).build()
                    ))
                    .build()
            )
            logger.info("Saved system API key for vendor $aiVendor to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save system API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun updateSystemApiKeyConfig(
        aiVendor: String,
        selectedModel: String,
        priority: Int
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                    .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                    .updateExpression("SET selectedModel = :m, #p = :p, updatedAt = :now")
                    // Config only makes sense on a vendor that has a stored key
                    .conditionExpression("attribute_exists($AI_VENDOR_KEY) AND attribute_exists(apiKey)")
                    .expressionAttributeNames(mapOf("#p" to "priority"))
                    .expressionAttributeValues(mapOf(
                        ":m" to AttributeValue.builder().s(selectedModel).build(),
                        ":p" to AttributeValue.builder().n(priority.toString()).build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                    ))
                    .build()
            )
            logger.info("Saved system vendor config for $aiVendor: model=$selectedModel priority=$priority")
        } catch (e: Exception) {
            logger.error("Failed to save system vendor config to DynamoDB", e)
            throw e
        }
    }

    suspend fun getSystemApiKeyItem(aiVendor: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                .build()

            val response = dynamoDbClient.getItem(request)
            if (response.hasItem()) response.item() else null
        }

    suspend fun deleteSystemApiKey(aiVendor: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                .build()
        )
        logger.info("Deleted system API key for vendor $aiVendor from DynamoDB")
    }

    /**
     * Upserts one vendor's model-catalog entries (token limits per model).
     * Batched in chunks of 25 — the BatchWriteItem maximum.
     */
    suspend fun saveModelCatalogEntries(
        aiVendor: String,
        entries: List<ModelCatalogEntry>
    ) = withContext(Dispatchers.IO) {
        val now = Instant.now().toString()
        entries.chunked(25).forEach { chunk ->
            val writeRequests = chunk.map { entry ->
                val item = buildMap {
                    put(AI_VENDOR_KEY, AttributeValue.builder().s(aiVendor).build())
                    put(DynamoDBConstants.MODEL_SORT_KEY, AttributeValue.builder().s(entry.model).build())
                    entry.maxOutputTokens?.let {
                        put("maxOutputTokens", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.maxInputTokens?.let {
                        put("maxInputTokens", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.inputCostPerMTok?.let {
                        put("inputCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.outputCostPerMTok?.let {
                        put("outputCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.cacheReadCostPerMTok?.let {
                        put("cacheReadCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.cacheWriteCostPerMTok?.let {
                        put("cacheWriteCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    put("updatedAt", AttributeValue.builder().s(now).build())
                }
                WriteRequest.builder()
                    .putRequest(PutRequest.builder().item(item).build())
                    .build()
            }
            var request = BatchWriteItemRequest.builder()
                .requestItems(mapOf(DynamoDBConstants.AI_MODEL_CATALOG_TABLE to writeRequests))
                .build()
            var response = dynamoDbClient.batchWriteItem(request)
            // Retry throttled leftovers so a partial batch never silently drops rows
            var retries = 0
            while (response.hasUnprocessedItems() && response.unprocessedItems().isNotEmpty() && retries < 3) {
                retries++
                Thread.sleep(200L * retries)
                request = BatchWriteItemRequest.builder()
                    .requestItems(response.unprocessedItems())
                    .build()
                response = dynamoDbClient.batchWriteItem(request)
            }
        }
        logger.info("Saved ${entries.size} model catalog entries for vendor $aiVendor")
    }

    suspend fun getModelCatalogEntry(aiVendor: String, model: String): ModelCatalogEntry? =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(DynamoDBConstants.AI_MODEL_CATALOG_TABLE)
                    .key(mapOf(
                        AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build(),
                        DynamoDBConstants.MODEL_SORT_KEY to AttributeValue.builder().s(model).build()
                    ))
                    .build()
            )
            val item = response.item()?.takeIf { it.isNotEmpty() } ?: return@withContext null
            ModelCatalogEntry(
                model = model,
                maxOutputTokens = item["maxOutputTokens"]?.n()?.toIntOrNull(),
                maxInputTokens = item["maxInputTokens"]?.n()?.toIntOrNull(),
                inputCostPerMTok = item["inputCostPerMTok"]?.n()?.toDoubleOrNull(),
                outputCostPerMTok = item["outputCostPerMTok"]?.n()?.toDoubleOrNull(),
                cacheReadCostPerMTok = item["cacheReadCostPerMTok"]?.n()?.toDoubleOrNull(),
                cacheWriteCostPerMTok = item["cacheWriteCostPerMTok"]?.n()?.toDoubleOrNull()
            )
        }

    private fun withTimestamps(base: Map<String, AttributeValue>): Map<String, AttributeValue> {
        val now = Instant.now().toString()
        return base + mapOf(
            "createdAt" to AttributeValue.builder().s(now).build(),
            "updatedAt" to AttributeValue.builder().s(now).build()
        )
    }


    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
            )

            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            val item = response.item() ?: return@withContext null

            // Parse result
            // Note: attributes are stored as 'preferredModels', 'preferredGenerativeMode' etc.
            // We need to map them back to AIConfigPreferences object
            
            val modelsAttr = item["preferredModels"]
            val preferredModels = modelsAttr?.let { attributeValueToAiConfig(it) }
            
            val modeAttr = item["preferredGenerativeMode"]?.s()
            val preferredGenerativeMode = modeAttr?.let { AIMode.valueOf(it) }

            AIConfigPreferences(
                preferredModels = preferredModels,
                preferredGenerativeMode = preferredGenerativeMode,
                embeddingMode = item["embeddingMode"]?.s(),
                embeddingModel = item["embeddingModel"]?.s(),
                preferredInstructionId = item["preferredInstructionId"]?.s(),
                instructionFallbackMode = item["instructionFallbackMode"]?.s()
            )
        }

    suspend fun getCustomerApiKeys(customerId: String): List<models.AIVendorAPIKeyStatus> =
        withContext(Dispatchers.IO) {
            val request = software.amazon.awssdk.services.dynamodb.model.QueryRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .keyConditionExpression("#cid = :cid")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()

            val response = dynamoDbClient.query(request)
            
            response.items().mapNotNull { item ->
                val vendorStr = item[AI_VENDOR_KEY]?.s() ?: return@mapNotNull null
                val aiVendor = try {
                    AIVendor.valueOf(vendorStr)
                } catch (e: Exception) {
                    return@mapNotNull null
                }
                
                // Check explicitly stored validation status AND presence of actual key
                val isStoredValid = item["isAPIKeyValid"]?.bool() ?: false
                val hasKey = !item["apiKey"]?.s().isNullOrBlank()
                
                // Fallback for legacy items: if valid flag missing but key present? 
                // We prefer explicit flag. If flag missing, assume true if key exists (legacy behavior) 
                // BUT if flag is TRUE and key is MISSING, that is invalid.
                
                val isValid = if (item.containsKey("isAPIKeyValid")) {
                    isStoredValid && hasKey
                } else {
                    hasKey
                }

                val status = if (!hasKey) {
                    models.APIKeyStatus.NOT_SET
                } else if (isValid) {
                    models.APIKeyStatus.VALID
                } else {
                    models.APIKeyStatus.INVALID
                }

                models.AIVendorAPIKeyStatus(
                    aiVendor = aiVendor,
                    isAPIKeyValid = isValid,
                    status = status
                )
            }
        }
        
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

    suspend fun getInstruction(instructionId: String, version: Int): models.Instruction? =
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

            // Check if Item is empty (getItem returns empty map if not found sometimes? No, usually null or empty map)
             if (item.isEmpty()) return@withContext null

            itemToInstruction(item)?.also { instruction ->
                // Cache the immutable content (positive-only). Clear on soft-cap
                // to keep memory bounded — the working set is tiny in practice.
                if (instructionCache.size >= INSTRUCTION_CACHE_MAX) instructionCache.clear()
                instructionCache[cacheKey] = instruction
            }
        }

    suspend fun saveInstruction(instruction: models.Instruction) = withContext(Dispatchers.IO) {
        try {
            val itemMap = mutableMapOf(
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(instruction.id).build(),
                INSTRUCTION_CREATOR_KEY to AttributeValue.builder().s(instruction.creator).build(),
                INSTRUCTION_NAME_KEY to AttributeValue.builder().s(instruction.name).build(),
                INSTRUCTION_CONTENT_KEY to AttributeValue.builder().s(instruction.instructions).build(),
                INSTRUCTION_VERSION_KEY to AttributeValue.builder().n(instruction.version.toString()).build()
            )

            instruction.icon?.let {
                itemMap[com.genflowly.DynamoDBConstants.INSTRUCTION_ICON_KEY] = AttributeValue.builder().s(it).build()
            }
            instruction.color?.let {
                itemMap[com.genflowly.DynamoDBConstants.INSTRUCTION_COLOR_KEY] = AttributeValue.builder().s(it).build()
            }
            instruction.category?.let {
                itemMap[com.genflowly.DynamoDBConstants.INSTRUCTION_CATEGORY_KEY] = AttributeValue.builder().s(it).build()
            }
            if (!instruction.tags.isNullOrEmpty()) {
                val tagList = instruction.tags.map { AttributeValue.builder().s(it).build() }
                itemMap[com.genflowly.DynamoDBConstants.INSTRUCTION_TAGS_KEY] = AttributeValue.builder().l(tagList).build()
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
    suspend fun getInstructionsByCreator(creatorId: String): List<models.Instruction> =
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
     * The global default instruction: the SYSTEM-created instruction at its
     * latest version (SYSTEM keeps one id whose version increases). Null if none
     * has been seeded.
     */
    // Resolved fresh each call so a newly published System version takes effect
    // immediately. The lookup is a single indexed query; the resolved version's
    // content is then served from the immutable instruction cache downstream.
    suspend fun getDefaultSystemInstruction(): models.Instruction? =
        getInstructionsByCreator(com.genflowly.DynamoDBConstants.SYSTEM_INSTRUCTION_CREATOR)
            .maxByOrNull { it.version ?: 0 }

    /**
     * The customer's most-recently-used instruction id (by lastUsedAt), or null
     * if they have never used one. Backs the "lastUsed" fallback mode.
     */
    suspend fun getLastUsedInstructionId(customerId: String): String? =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.INSTRUCTION_USAGE_TABLE)
                .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()

            dynamoDbClient.query(request).items()
                .maxByOrNull { it[com.genflowly.DynamoDBConstants.INSTRUCTION_LAST_USED_KEY]?.s() ?: "" }
                ?.get(INSTRUCTION_ID_KEY)?.s()
        }

    private fun itemToInstruction(item: Map<String, AttributeValue>): models.Instruction? {
        return models.Instruction(
            id = item[INSTRUCTION_ID_KEY]?.s() ?: return null,
            creator = item[INSTRUCTION_CREATOR_KEY]?.s() ?: return null,
            name = item[INSTRUCTION_NAME_KEY]?.s() ?: "",
            instructions = item[INSTRUCTION_CONTENT_KEY]?.s() ?: "",
            version = item[INSTRUCTION_VERSION_KEY]?.n()?.toInt() ?: 1,
            icon = item[com.genflowly.DynamoDBConstants.INSTRUCTION_ICON_KEY]?.s(),
            color = item[com.genflowly.DynamoDBConstants.INSTRUCTION_COLOR_KEY]?.s(),
            category = item[com.genflowly.DynamoDBConstants.INSTRUCTION_CATEGORY_KEY]?.s(),
            tags = item[com.genflowly.DynamoDBConstants.INSTRUCTION_TAGS_KEY]?.l()?.mapNotNull { it.s() }
        )
    }

    suspend fun shareEntityWithCustomer(entityId: String, sharedWithCustomerId: String, sharedByCustomerId: String, role: String) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(entityId).build(),
                com.genflowly.DynamoDBConstants.SHARED_BY_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedByCustomerId).build(),
                com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY to AttributeValue.builder().s(role).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Shared entity $entityId with $sharedWithCustomerId (by $sharedByCustomerId, role=$role)")
        } catch (e: Exception) {
            logger.error("Failed to share entity", e)
            throw e
        }
    }

    suspend fun unshareEntityWithCustomer(entityId: String, sharedWithCustomerId: String) = withContext(Dispatchers.IO) {
        try {
            val deleteReq = DeleteItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
                .key(
                    mapOf(
                        com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                        INSTRUCTION_ID_KEY to AttributeValue.builder().s(entityId).build()
                    )
                )
                .build()

            dynamoDbClient.deleteItem(deleteReq)
            logger.info("Unshared entity $entityId with $sharedWithCustomerId")
        } catch (e: Exception) {
            logger.error("Failed to unshare entity", e)
            throw e
        }
    }

    suspend fun getSharedEntityIdsForCustomer(customerId: String, prefix: String? = null): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
            .keyConditionExpression("${com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY} = :cid")
            .expressionAttributeValues(
                mapOf(":cid" to AttributeValue.builder().s(customerId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { item ->
            val id = item[INSTRUCTION_ID_KEY]?.s()
            val role = item[com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"
            if (id != null) id to role else null
        }.filter { prefix == null || it.first.startsWith(prefix) }
    }

    suspend fun getUsersWithSharedEntity(entityId: String): List<models.CustomerProfile> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
            .indexName(com.genflowly.DynamoDBConstants.SHARED_INSTRUCTIONS_GSI_KEY)
            .keyConditionExpression("$INSTRUCTION_ID_KEY = :id")
            .expressionAttributeValues(
                mapOf(":id" to AttributeValue.builder().s(entityId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)
        
        response.items().mapNotNull { item ->
            val customerId = item[com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s() ?: return@mapNotNull null
            val role = item[com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"
            
            if (customerId == "PUBLIC") {
                return@mapNotNull models.CustomerProfile(
                    customerId = "PUBLIC",
                    sub = "",
                    client = "",
                    email = null,
                    name = "Public",
                    picture = null,
                    username = "Public",
                    isDiscoverable = true,
                    role = role
                )
            }
            
            val profileItem = getCustomerProfileByCustomerId(customerId)
            if (profileItem != null) {
                models.CustomerProfile(
                    customerId = customerId,
                    sub = profileItem["sub"]?.s() ?: "",
                    client = profileItem["client"]?.s() ?: "",
                    email = profileItem["email"]?.s(),
                    name = profileItem["name"]?.s(),
                    picture = profileItem["picture"]?.s(),
                    username = profileItem["username"]?.s(),
                    isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false,
                    role = role
                )
            } else null
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
            .indexName(com.genflowly.DynamoDBConstants.CONVERSATION_ID_GSI_KEY)
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

    suspend fun shareConversationWithCustomer(
        conversationId: String,
        sharedWithCustomerId: String,
        sharedByCustomerId: String,
        role: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build(),
                com.genflowly.DynamoDBConstants.SHARED_BY_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedByCustomerId).build(),
                com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY to AttributeValue.builder().s(role).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Shared conversation $conversationId with $sharedWithCustomerId (by $sharedByCustomerId, role=$role)")
        } catch (e: Exception) {
            logger.error("Failed to share conversation", e)
            throw e
        }
    }

    suspend fun unshareConversationWithCustomer(
        conversationId: String,
        sharedWithCustomerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            val deleteReq = DeleteItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .key(
                    mapOf(
                        com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    )
                )
                .build()

            dynamoDbClient.deleteItem(deleteReq)
            logger.info("Unshared conversation $conversationId with $sharedWithCustomerId")
        } catch (e: Exception) {
            logger.error("Failed to unshare conversation", e)
            throw e
        }
    }

    suspend fun unshareAllConversationWithCustomer(
        conversationId: String
    ) = withContext(Dispatchers.IO) {
        try {
            val request = QueryRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .indexName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY)
                .keyConditionExpression("$CONVERSATION_ID_KEY = :id")
                .expressionAttributeValues(
                    mapOf(":id" to AttributeValue.builder().s(conversationId).build())
                )
                .build()

            val response = dynamoDbClient.query(request)
            
            response.items().forEach { item ->
                val sharedWithCustomerId = item[com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s()
                if (sharedWithCustomerId != null) {
                    unshareConversationWithCustomer(conversationId, sharedWithCustomerId)
                }
            }
            logger.info("Unshared all for conversation $conversationId")
        } catch (e: Exception) {
            logger.error("Failed to unshare all for conversation $conversationId", e)
            throw e
        }
    }

    /**
     * Returns (conversationId, role) pairs for every conversation shared with [customerId],
     * including any PUBLIC entries the customer inherits.
     */
    suspend fun getSharedConversationIdsForCustomer(customerId: String): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .keyConditionExpression("${com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY} = :cid")
            .expressionAttributeValues(
                mapOf(":cid" to AttributeValue.builder().s(customerId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { item ->
            val id = item[CONVERSATION_ID_KEY]?.s()
            val role = item[com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"
            if (id != null) id to role else null
        }
    }

    /**
     * Returns the effective share role for [customerId] on [conversationId] via a direct
     * SharedConversations lookup, or null if no share exists. Does NOT consider PUBLIC —
     * callers should check PUBLIC separately.
     */
    suspend fun getConversationShare(conversationId: String, customerId: String): String? = withContext(Dispatchers.IO) {
        val request = GetItemRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .key(mapOf(
                com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
            ))
            .build()
        val item = dynamoDbClient.getItem(request).item()
        if (item.isNullOrEmpty()) null
        else item[com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY]?.s()
    }

    suspend fun getUsersWithSharedConversation(conversationId: String): List<models.CustomerProfile> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .indexName(com.genflowly.DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY)
            .keyConditionExpression("$CONVERSATION_ID_KEY = :id")
            .expressionAttributeValues(
                mapOf(":id" to AttributeValue.builder().s(conversationId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)

        response.items().mapNotNull { item ->
            val customerId = item[com.genflowly.DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s() ?: return@mapNotNull null
            val role = item[com.genflowly.DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"

            if (customerId == "PUBLIC") {
                return@mapNotNull models.CustomerProfile(
                    customerId = "PUBLIC",
                    sub = "",
                    client = "",
                    email = null,
                    name = "Public",
                    picture = null,
                    username = "Public",
                    isDiscoverable = true,
                    role = role
                )
            }

            val profileItem = getCustomerProfileByCustomerId(customerId)
            if (profileItem != null) {
                models.CustomerProfile(
                    customerId = customerId,
                    sub = profileItem["sub"]?.s() ?: "",
                    client = profileItem["client"]?.s() ?: "",
                    email = profileItem["email"]?.s(),
                    name = profileItem["name"]?.s(),
                    picture = profileItem["picture"]?.s(),
                    username = profileItem["username"]?.s(),
                    isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false,
                    role = role
                )
            } else null
        }
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
                val deleteReq = software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest.builder()
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

    // ─── Graph Nodes ──────────────────────────────────────────────────────────

    suspend fun createCustomerGraphNode(
        customerId: String,
        nodeId: String,
        nodeType: String,
        name: String,
        config: String
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val baseFields = mapOf(
                NODE_TYPE_KEY to AttributeValue.builder().s(nodeType).build(),
                NODE_NAME_KEY to AttributeValue.builder().s(name).build(),
                NODE_CONFIG_KEY to AttributeValue.builder().s(config).build(),
            )
            // v=1: history snapshot (no customerId → excluded from GSI)
            val historyItem = baseFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            // v=0: current/live item with customerId for GSI
            val currentItem = baseFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(currentItem).build())
            logger.info("Created graph node $nodeId ($nodeType) v1 for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to create graph node $nodeId for customer $customerId", e)
            throw e
        }
    }

    suspend fun updateCustomerGraphNode(
        nodeId: String,
        nodeType: String,
        name: String,
        config: String
    ): Map<String, AttributeValue> = withContext(Dispatchers.IO) {
        val current = getCustomerGraphNode(nodeId) ?: error("Graph node $nodeId not found")
        val latestVersion = current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1
        val nextVersion = latestVersion + 1
        val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on node $nodeId")
        val createdAt = current["createdAt"]?.s() ?: Instant.now().toString()
        val now = Instant.now().toString()

        val baseFields = mapOf(
            NODE_TYPE_KEY to AttributeValue.builder().s(nodeType).build(),
            NODE_NAME_KEY to AttributeValue.builder().s(name).build(),
            NODE_CONFIG_KEY to AttributeValue.builder().s(config).build(),
        )
        val historyItem = baseFields + mapOf(
            NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
            VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(now).build(),
        )
        val updatedCurrent = baseFields + mapOf(
            NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
            VERSION_KEY to AttributeValue.builder().n("0").build(),
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            LATEST_VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(createdAt).build(),
            "updatedAt" to AttributeValue.builder().s(now).build(),
        )
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(updatedCurrent).build())
        logger.info("Updated graph node $nodeId to v$nextVersion")
        updatedCurrent
    }

    suspend fun getCustomerGraphNode(nodeId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                val request = GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .build()
                val item = dynamoDbClient.getItem(request).item()
                if (item.isNullOrEmpty() || item.containsKey(DELETED_AT_KEY)) null else item
            } catch (e: Exception) {
                logger.error("Failed to get graph node $nodeId", e)
                null
            }
        }

    suspend fun deleteCustomerGraphNode(nodeId: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .updateExpression("SET #da = :now")
                    .expressionAttributeNames(mapOf("#da" to DELETED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Soft-deleted graph node $nodeId")
        } catch (e: Exception) {
            logger.error("Failed to delete graph node $nodeId", e)
            throw e
        }
    }

    suspend fun listCustomerGraphNodes(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                        .indexName(CUSTOMER_GRAPH_NODES_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#da" to DELETED_AT_KEY))
                        .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to list graph nodes for customer $customerId", e)
                emptyList()
            }
        }

    suspend fun getCustomerGraphNodeVersions(nodeId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                        .keyConditionExpression("#nid = :nid AND #v > :zero")
                        .expressionAttributeNames(mapOf("#nid" to NODE_ID_KEY, "#v" to VERSION_KEY))
                        .expressionAttributeValues(mapOf(
                            ":nid" to AttributeValue.builder().s(nodeId).build(),
                            ":zero" to AttributeValue.builder().n("0").build(),
                        ))
                        .scanIndexForward(false)
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to get versions for graph node $nodeId", e)
                emptyList()
            }
        }

    suspend fun rollbackCustomerGraphNode(nodeId: String, toVersion: Int): Map<String, AttributeValue> =
        withContext(Dispatchers.IO) {
            val target = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n(toVersion.toString()).build(),
                    ))
                    .build()
            ).item()
            require(!target.isNullOrEmpty()) { "Version $toVersion not found for node $nodeId" }

            val current = getCustomerGraphNode(nodeId) ?: error("Graph node $nodeId not found")
            val latestVersion = (current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 0) + 1
            val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on node $nodeId")
            val now = Instant.now().toString()

            val restoredFields = mapOf(
                NODE_TYPE_KEY to (target[NODE_TYPE_KEY] ?: current[NODE_TYPE_KEY]!!),
                NODE_NAME_KEY to (target[NODE_NAME_KEY] ?: current[NODE_NAME_KEY]!!),
                NODE_CONFIG_KEY to (target[NODE_CONFIG_KEY] ?: current[NODE_CONFIG_KEY]!!),
            )
            val historyItem = restoredFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val updatedCurrent = restoredFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(current["createdAt"]?.s() ?: now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(updatedCurrent).build())
            logger.info("Rolled back graph node $nodeId to v$toVersion (new snapshot v$latestVersion)")
            updatedCurrent
        }

    // ─── Graphs ───────────────────────────────────────────────────────────────

    suspend fun createCustomerGraph(
        customerId: String,
        graphId: String,
        name: String,
        isDefault: Boolean,
        nodeIds: List<String>,
        edges: String,
        entryPoint: String,
        maxIterations: Int = 10
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val nodeIdAttrList = nodeIds.map { AttributeValue.builder().s(it).build() }
            val baseFields = mapOf(
                GRAPH_NAME_KEY to AttributeValue.builder().s(name).build(),
                GRAPH_IS_DEFAULT_KEY to AttributeValue.builder().bool(isDefault).build(),
                GRAPH_NODE_IDS_KEY to AttributeValue.builder().l(nodeIdAttrList).build(),
                GRAPH_EDGES_KEY to AttributeValue.builder().s(edges).build(),
                GRAPH_ENTRY_POINT_KEY to AttributeValue.builder().s(entryPoint).build(),
                GRAPH_MAX_ITERATIONS_KEY to AttributeValue.builder().n(maxIterations.toString()).build(),
            )
            val historyItem = baseFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val currentItem = baseFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(currentItem).build())
            logger.info("Created graph $graphId ($name) v1 for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to create graph $graphId for customer $customerId", e)
            throw e
        }
    }

    suspend fun updateCustomerGraph(
        graphId: String,
        name: String,
        isDefault: Boolean,
        nodeIds: List<String>,
        edges: String,
        entryPoint: String,
        maxIterations: Int
    ): Map<String, AttributeValue> = withContext(Dispatchers.IO) {
        val current = getCustomerGraph(graphId) ?: error("Graph $graphId not found")
        val latestVersion = current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1
        val nextVersion = latestVersion + 1
        val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on graph $graphId")
        val createdAt = current["createdAt"]?.s() ?: Instant.now().toString()
        val now = Instant.now().toString()

        val nodeIdAttrList = nodeIds.map { AttributeValue.builder().s(it).build() }
        val baseFields = mapOf(
            GRAPH_NAME_KEY to AttributeValue.builder().s(name).build(),
            GRAPH_IS_DEFAULT_KEY to AttributeValue.builder().bool(isDefault).build(),
            GRAPH_NODE_IDS_KEY to AttributeValue.builder().l(nodeIdAttrList).build(),
            GRAPH_EDGES_KEY to AttributeValue.builder().s(edges).build(),
            GRAPH_ENTRY_POINT_KEY to AttributeValue.builder().s(entryPoint).build(),
            GRAPH_MAX_ITERATIONS_KEY to AttributeValue.builder().n(maxIterations.toString()).build(),
        )
        val historyItem = baseFields + mapOf(
            GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
            VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(now).build(),
        )
        val updatedCurrent = baseFields + mapOf(
            GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
            VERSION_KEY to AttributeValue.builder().n("0").build(),
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            LATEST_VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(createdAt).build(),
            "updatedAt" to AttributeValue.builder().s(now).build(),
        )
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(updatedCurrent).build())
        logger.info("Updated graph $graphId to v$nextVersion")
        updatedCurrent
    }

    suspend fun getCustomerGraph(graphId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                val request = GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .build()
                val item = dynamoDbClient.getItem(request).item()
                if (item.isNullOrEmpty() || item.containsKey(DELETED_AT_KEY)) null else item
            } catch (e: Exception) {
                logger.error("Failed to get graph $graphId", e)
                null
            }
        }

    suspend fun deleteCustomerGraph(graphId: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .updateExpression("SET #da = :now")
                    .expressionAttributeNames(mapOf("#da" to DELETED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Soft-deleted graph $graphId")
        } catch (e: Exception) {
            logger.error("Failed to delete graph $graphId", e)
            throw e
        }
    }

    suspend fun listCustomerGraphs(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .indexName(CUSTOMER_GRAPHS_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#da" to DELETED_AT_KEY))
                        .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to list graphs for customer $customerId", e)
                emptyList()
            }
        }

    suspend fun getDefaultCustomerGraph(customerId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                // Sparse GSI: only v=0 items have customerId, so all results are current-state.
                // Scan up to 20 to find one with isDefault=true (most customers have very few graphs).
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .indexName(CUSTOMER_GRAPHS_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("#isDefault = :true AND attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf(
                            "#cid" to CUSTOMER_ID_KEY,
                            "#isDefault" to GRAPH_IS_DEFAULT_KEY,
                            "#da" to DELETED_AT_KEY,
                        ))
                        .expressionAttributeValues(mapOf(
                            ":cid" to AttributeValue.builder().s(customerId).build(),
                            ":true" to AttributeValue.builder().bool(true).build(),
                        ))
                        .limit(20)
                        .build()
                ).items().firstOrNull()
            } catch (e: Exception) {
                logger.error("Failed to get default graph for customer $customerId", e)
                null
            }
        }

    suspend fun getCustomerGraphVersions(graphId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .keyConditionExpression("#gid = :gid AND #v > :zero")
                        .expressionAttributeNames(mapOf("#gid" to GRAPH_ID_KEY, "#v" to VERSION_KEY))
                        .expressionAttributeValues(mapOf(
                            ":gid" to AttributeValue.builder().s(graphId).build(),
                            ":zero" to AttributeValue.builder().n("0").build(),
                        ))
                        .scanIndexForward(false)
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to get versions for graph $graphId", e)
                emptyList()
            }
        }

    suspend fun rollbackCustomerGraph(graphId: String, toVersion: Int): Map<String, AttributeValue> =
        withContext(Dispatchers.IO) {
            val target = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n(toVersion.toString()).build(),
                    ))
                    .build()
            ).item()
            require(!target.isNullOrEmpty()) { "Version $toVersion not found for graph $graphId" }

            val current = getCustomerGraph(graphId) ?: error("Graph $graphId not found")
            val latestVersion = (current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 0) + 1
            val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on graph $graphId")
            val now = Instant.now().toString()

            val restoredFields = listOf(
                GRAPH_NAME_KEY, GRAPH_IS_DEFAULT_KEY, GRAPH_NODE_IDS_KEY,
                GRAPH_EDGES_KEY, GRAPH_ENTRY_POINT_KEY, GRAPH_MAX_ITERATIONS_KEY
            ).mapNotNull { key -> target[key]?.let { key to it } }.toMap()

            val historyItem = restoredFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val updatedCurrent = restoredFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(current["createdAt"]?.s() ?: now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(updatedCurrent).build())
            logger.info("Rolled back graph $graphId to v$toVersion (new snapshot v$latestVersion)")
            updatedCurrent
        }

    suspend fun saveCustomerToolCredentials(
        customerId: String,
        toolType: String,
        authType: String,
        encryptedCredentials: String,
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                com.genflowly.DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                com.genflowly.DynamoDBConstants.TOOL_AUTH_TYPE_KEY to AttributeValue.builder().s(authType).build(),
                com.genflowly.DynamoDBConstants.TOOL_CREDENTIALS_KEY to AttributeValue.builder().s(encryptedCredentials).build(),
            ))
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                    .item(item)
                    .build()
            )
            logger.info("Saved tool credentials for $customerId / $toolType")
        } catch (e: Exception) {
            logger.error("Failed to save tool credentials for $customerId / $toolType", e)
            throw e
        }
    }

    suspend fun getCustomerToolCredentials(
        customerId: String,
        toolType: String,
    ): Map<String, AttributeValue>? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                .key(mapOf(
                    com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    com.genflowly.DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                ))
                .build()
        )
        response.item()?.takeIf { it.isNotEmpty() }
    }

    suspend fun listCustomerToolCredentials(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                    .keyConditionExpression("#cid = :cid")
                    .expressionAttributeNames(mapOf("#cid" to com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY))
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            )
            response.items()
        }

    suspend fun deleteCustomerToolCredentials(customerId: String, toolType: String) =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.deleteItem(
                    DeleteItemRequest.builder()
                        .tableName(com.genflowly.DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                        .key(mapOf(
                            com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                            com.genflowly.DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                        ))
                        .build()
                )
                logger.info("Deleted tool credentials for $customerId / $toolType")
            } catch (e: Exception) {
                logger.error("Failed to delete tool credentials for $customerId / $toolType", e)
                throw e
            }
        }

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
                com.genflowly.DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY
                    to AttributeValue.builder().s(convInstKey).build()
            )
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(com.genflowly.DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE)
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
                .tableName(com.genflowly.DynamoDBConstants.INSTRUCTION_USAGE_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    INSTRUCTION_ID_KEY to AttributeValue.builder().s(instructionId).build()
                ))
                .updateExpression(
                    "SET ${com.genflowly.DynamoDBConstants.INSTRUCTION_LAST_USED_KEY} = :ts " +
                    "ADD ${com.genflowly.DynamoDBConstants.INSTRUCTION_USAGE_COUNT_KEY} :one"
                )
                .expressionAttributeValues(mapOf(
                    ":ts"  to AttributeValue.builder().s(lastUsedAt).build(),
                    ":one" to AttributeValue.builder().n("1").build()
                ))
                .build()
        )
        logger.info("Incremented usage count for instruction $instructionId / customer $customerId")
    }
}