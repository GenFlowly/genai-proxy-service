package com.genflowly.providers

import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CLIENT_SORT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_TABLE
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.SUB_PARTITION_KEY
import com.genflowly.aicallerlib.models.AIVendor
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import models.AIConfig
import models.Conversation
import models.Message
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest

class DynamoDBProvider(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {
//    suspend fun getConversation(conversationId: String, customerId: String): Conversation? =
//        withContext(Dispatchers.IO) {
//            try {
//                val key = mapOf(
//                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build(),
//                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
//                )
//
//                val request = GetItemRequest.builder()
//                    .tableName(CONVERSATION_TABLE)
//                    .key(key)
//                    .build()
//
//                val response = dynamoDbClient.getItem(request)
//                val item = response.item() ?: return@withContext null
//
//                val client = item["client"]?.s() ?: return@withContext null
//
//                Conversation(
//                    conversationId = conversationId,
//                    customerId = customerId,
//                    client = client
//                )
//            } catch (e: Exception) {
//                logger.error("Failed to Get Conversation from DynamoDB", e)
//                throw e
//            }
//        }

    suspend fun getMessage(conversationId: String, messageId: String): Message? = withContext(Dispatchers.IO) {
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

        val aiConfigJson = item["aiConfig"]?.s()
        val aiConfig = aiConfigJson?.takeIf { it.isNotBlank() }?.let {
            runCatching { Json.decodeFromString<AIConfig>(it) }.getOrNull()
        }

        val text = item["text"]?.s() ?: return@withContext null
        val sequenceStr = item["sequence"]?.n() ?: return@withContext null
        val client = item["client"]?.s() ?: return@withContext null
        val role = item["role"]?.s() ?: return@withContext null
        val customerId = item["customerId"]?.s() ?: return@withContext null
        val previousMessageId = item["previousMessageId"]?.s() ?: return@withContext null
        val systemPrompt = item["systemPrompt"]?.s() ?: return@withContext null



        val sequence = sequenceStr.toIntOrNull() ?: return@withContext null

        return@withContext Message(
            messageId = item["messageId"]?.s() ?: return@withContext null,
            conversationId = item["conversationId"]?.s() ?: return@withContext null,
            aiConfig = aiConfig,
            text = text,
            sequence = sequence,
            client = client,
            role = role,
            customerId = customerId,
            previousMessageId = previousMessageId,
            systemPrompt = systemPrompt
        )
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

    suspend fun createMessage(
        message: Message
    ) = withContext(Dispatchers.IO) {
        try {
            val aiConfigJson = message.aiConfig?.let { Json.encodeToString(it) } ?: ""
            val item = withTimestamps(mapOf(
                CONVERSATION_ID_KEY to AttributeValue.builder()
                    .s(message.conversationId).build(),
                MESSAGE_ID_SORT_KEY to AttributeValue.builder().s(message.messageId)
                    .build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s
                    (message.customerId)
                    .build(),
                "sequence" to AttributeValue.builder().n
                    (message.sequence.toString())
                    .build(),
                "client" to AttributeValue.builder().s
                    (message.client)
                    .build(),
                "aiConfig" to AttributeValue.builder().s(aiConfigJson).build(),
                "role" to AttributeValue.builder().s
                    (message.role)
                    .build(),
                "text" to AttributeValue.builder().s
                    (message.text)
                    .build(),
                "previousMessageId" to AttributeValue.builder().s
                    (message.previousMessageId)
                    .build(),
            ))

            val putReq = PutItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved message for conversation" +
                    " ${message.conversationId} to " +
                    "DynamoDB")

        } catch (e: Exception) {
            logger.error("Failed to Create Message in DynamoDB", e)
            throw e
        }

    }

    suspend fun saveAIConfigPreferences(        customerId: String,
                                                preferredModels: Map<String, String>,
                                                preferredGenerativeMode: String,
                                                otherPreferences: Map<String,
                                                        String>) {

        try {
            // todo BUILD Item

//        todo val putReq = PutItemRequest.builder()
//            .tableName(CUSTOMER_PREFERENCES_TABLE)
//            .item(item)
//            .build()

            // todo dynamoDbClient.putItem(putReq)
        } catch (e: Exception) {
            logger.error("Failed to save Customer Preferences to " +
                    "DynamoDB", e)
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

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?,
        picture: String?
    ) = withContext(Dispatchers.IO) {
        val baseItem = buildMap {
            put(SUB_PARTITION_KEY, AttributeValue.builder().s(sub).build())
            put(CLIENT_SORT_KEY, AttributeValue.builder().s(client).build())
            put("customerId", AttributeValue.builder().s(customerId).build())

            email?.let { put("email", AttributeValue.builder().s(it).build()) }
            name?.let { put("name", AttributeValue.builder().s(it).build()) }
            picture?.let { put("picture", AttributeValue.builder().s(it).build()) }
        }

        val item = withTimestamps(baseItem)

        val putReq = PutItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .item(item)
            .build()

        dynamoDbClient.putItem(putReq)
        logger.info { "Onboarded user $sub in DynamoDB with customerId: $customerId" }
    }

    suspend fun getCustomerProfile(sub: String, client: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            )

            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            return@withContext if (response.hasItem()) response.item() else null
        }

    /**
     * Query customer profile by sub only (partition key)
     * Returns the first matching profile if multiple clients exist for the same sub
     */
    suspend fun queryCustomerProfileBySub(sub: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = software.amazon.awssdk.services.dynamodb.model.QueryRequest.builder()
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


    private fun withTimestamps(base: Map<String, AttributeValue>): Map<String, AttributeValue> {
        val now = Instant.now().toString()
        return base + mapOf(
            "createdAt" to AttributeValue.builder().s(now).build(),
            "updatedAt" to AttributeValue.builder().s(now).build()
        )
    }

}